import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { claimQueuedDeployment, markDeploymentFailed } from '#shared/deployments.ts'
import { parseCommitSha, type CommitSha, type DeploymentId } from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { databasePath } from '#shared/paths.ts'
import { loadProject } from '#shared/projects.ts'
import { runClaimedBuild, type BuildTools } from './build.ts'
import type { CloneRequest } from './clone.ts'
import { buildContainerUser, type BuildContainerPlan } from './container.ts'
import { openLogWriter } from './logwriter.ts'
import type { ContainerOutcome } from './outcome.ts'
import { discardBuildScratch, inspectBuildOutput, publishBuildOutput } from './publish.ts'
import { parseWorkerSettings } from './settings.ts'
import type { LineSink } from './subprocess.ts'

const BUILT_BY_FILE = 'built-by'
const CLONED_COMMIT_SHA = parseCommitSha('0'.repeat(40))

function cloneIntoEmptyRepoDir(request: CloneRequest): Promise<Parsed<CommitSha>> {
    mkdirSync(request.intoDir, { recursive: true })

    return Promise.resolve(
        CLONED_COMMIT_SHA === null ? invalid('forty zeroes is not a commit sha') : valid(CLONED_COMMIT_SHA),
    )
}

function writeOutputInsteadOfRunningContainer(
    plan: BuildContainerPlan,
    outputDir: string,
    label: string,
    onLine: LineSink,
): Promise<ContainerOutcome> {
    const path = join(plan.repoDir, outputDir)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, BUILT_BY_FILE), label)

    onLine('stdout', `${label} built ${plan.deploymentId}`)
    onLine('stdout', `${label} wrote ${outputDir}`)

    return Promise.resolve({ kind: 'exited', code: 0 })
}

function buildToolsWithoutContainer(label: string, outputDir: string): BuildTools {
    return {
        cloneRepository: cloneIntoEmptyRepoDir,
        runBuildContainer: (plan, onLine) => writeOutputInsteadOfRunningContainer(plan, outputDir, label, onLine),
        inspectBuildOutput,
        publishBuildOutput,
        discardBuildScratch,
        openLogWriter,
    }
}

function failClaimedDeployment(db: DatabaseSync, id: DeploymentId, error: string): void {
    if (markDeploymentFailed(db, id, error) === 'ignored') console.error(`${id} was already finished elsewhere`)
}

const [startAtRaw, label] = process.argv.slice(2)
if (startAtRaw === undefined || label === undefined) {
    console.log('ERR usage: buildrace.child.ts <startAtEpochMs> <workerLabel>')
    process.exit(1)
}

const settings = parseWorkerSettings(process.env)
if (!settings.ok) {
    console.log(`ERR ${settings.error}`)
    process.exit(1)
}

const user = buildContainerUser()
if (!user.ok) {
    console.log(`ERR ${user.error}`)
    process.exit(1)
}

try {
    const db = openDatabase(databasePath())

    // Spin after the open, not before it: opening costs enough that a pre-open spin
    // lets the quickest sibling drain the queue before the others reach a claim.
    while (Date.now() < Number(startAtRaw)) { /* spin to a start instant shared with the siblings */ }

    const built: string[] = []
    for (;;) {
        const claimed = claimQueuedDeployment(db)
        if (claimed === null) break
        if (!claimed.ok) {
            console.log(`ERR ${claimed.error}`)
            process.exit(1)
        }

        const deployment = claimed.value
        built.push(deployment.id)

        const project = loadProject(db, deployment.projectId)
        if (project === null) {
            failClaimedDeployment(db, deployment.id, `project ${deployment.projectId} no longer exists`)
            continue
        }
        if (!project.ok) {
            failClaimedDeployment(db, deployment.id, project.error)
            continue
        }

        await runClaimedBuild(
            db,
            buildToolsWithoutContainer(label, project.value.outputDir),
            settings.value.limits,
            settings.value.cloneTimeoutMs,
            user.value,
            deployment,
            project.value,
        )
    }

    db.close()
    console.log(`OK ${built.join(' ')}`)
} catch (cause) {
    console.log(`ERR ${cause instanceof Error ? cause.message : String(cause)}`)
}
