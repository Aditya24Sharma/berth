import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import {
    claimQueuedDeployment,
    failAbandonedDeployments,
    markDeploymentFailed,
    type BuildingDeployment,
} from '#shared/deployments.ts'
import type { DeploymentId } from '#shared/ids.ts'
import { berthDataDir, databasePath } from '#shared/paths.ts'
import { loadProject, type Project } from '#shared/projects.ts'
import { realBuildTools, runClaimedBuild } from './build.ts'
import {
    buildContainerUser,
    checkDockerDaemon,
    ensureBuildImage,
    killBuildContainer,
    killOrphanedBuildContainers,
} from './container.ts'
import type { TerminalStatus } from './outcome.ts'
import { clearTrash } from './publish.ts'
import { parseWorkerSettings, type BuildLimits, type WorkerSettings } from './settings.ts'

const ABANDONED_GRACE_SECONDS = 60
const ABANDONED_BY_ITS_WORKER = 'the worker that claimed this build is gone'
const SHUT_DOWN_MID_BUILD = 'the worker was shut down mid-build'

type InFlightBuild = {
    readonly id: DeploymentId
    readonly settled: Promise<TerminalStatus>
}

type PollOutcome = 'claimedOne' | 'nothingQueued'

let inFlightBuild: InFlightBuild | null = null
let isStopping = false

function exitWithError(error: string): never {
    console.error(error)
    process.exit(1)
}

function removeBuildScratch(): void {
    rmSync(join(berthDataDir(), 'builds'), { recursive: true, force: true })
}

function abandonedAfterSeconds(limits: BuildLimits): number {
    return 2 * Math.ceil(limits.timeoutMs / 1000) + ABANDONED_GRACE_SECONDS
}

function failClaimedDeployment(db: DatabaseSync, id: DeploymentId, error: string): void {
    try {
        if (markDeploymentFailed(db, id, error) === 'applied') console.error(`berth worker: ${id} failed: ${error}`)
    } catch (cause) {
        console.error(`berth worker: could not record the failure of ${id}: ${String(cause)}`)
    }
}

function failAbandonedBuilds(db: DatabaseSync, limits: BuildLimits): void {
    const abandoned = failAbandonedDeployments(db, abandonedAfterSeconds(limits), ABANDONED_BY_ITS_WORKER)
    if (!abandoned.ok) {
        console.error(`berth worker: could not fail abandoned builds: ${abandoned.error}`)
        return
    }

    for (const id of abandoned.value) console.error(`berth worker: ${id} failed: ${ABANDONED_BY_ITS_WORKER}`)
}

async function buildInFlight(
    db: DatabaseSync,
    settings: WorkerSettings,
    user: string,
    deployment: BuildingDeployment,
    project: Project,
): Promise<void> {
    const settled = runClaimedBuild(
        db,
        realBuildTools,
        settings.limits,
        settings.cloneTimeoutMs,
        user,
        deployment,
        project,
    )
    inFlightBuild = { id: deployment.id, settled }

    try {
        const terminal = await settled

        // A shutdown records and reports its own reason for ending this build, and that is
        // the one the deployment row keeps.
        if (isStopping) return

        if (terminal.status === 'ready') console.log(`berth worker: ${deployment.id} is ready`)
        else console.error(`berth worker: ${deployment.id} failed: ${terminal.error}`)
    } catch (cause) {
        console.error(`berth worker: the build of ${deployment.id} stopped unexpectedly: ${String(cause)}`)
    } finally {
        inFlightBuild = null
    }
}

async function claimAndBuildNext(db: DatabaseSync, settings: WorkerSettings, user: string): Promise<PollOutcome> {
    const claimed = claimQueuedDeployment(db)
    if (claimed === null) return 'nothingQueued'

    if (!claimed.ok) {
        console.error(`berth worker: could not read the deployment it claimed: ${claimed.error}`)
        return 'claimedOne'
    }

    const deployment = claimed.value
    const project = loadProject(db, deployment.projectId)

    if (project === null) {
        failClaimedDeployment(db, deployment.id, `project ${deployment.projectId} no longer exists`)
        return 'claimedOne'
    }
    if (!project.ok) {
        failClaimedDeployment(db, deployment.id, project.error)
        return 'claimedOne'
    }

    console.log(`berth worker: building ${deployment.id} for project ${deployment.projectId}`)
    await buildInFlight(db, settings, user, deployment, project.value)

    return 'claimedOne'
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

async function pollUntilStopped(db: DatabaseSync, settings: WorkerSettings, user: string): Promise<void> {
    while (!isStopping) {
        failAbandonedBuilds(db, settings.limits)

        const polled = await claimAndBuildNext(db, settings, user)
        if (polled === 'nothingQueued' && !isStopping) await sleep(settings.pollIntervalMs)
    }
}

// The build container outlives the worker that started it: it is the only thing holding the
// memory, cpu and pid limits, and its own deadline is a backstop, not a shutdown.
async function stopAndExit(db: DatabaseSync, signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    if (isStopping) return
    isStopping = true
    console.log(`berth worker: ${signal} received, shutting down`)

    const running = inFlightBuild
    if (running !== null) {
        failClaimedDeployment(db, running.id, SHUT_DOWN_MID_BUILD)
        await killBuildContainer(running.id)

        try {
            await running.settled
        } catch (cause) {
            console.error(`berth worker: the build of ${running.id} stopped unexpectedly: ${String(cause)}`)
        }
    }

    db.close()
    process.exit(0)
}

const settings = parseWorkerSettings(process.env)
if (!settings.ok) exitWithError(settings.error)

const user = buildContainerUser()
if (!user.ok) exitWithError(user.error)

const docker = await checkDockerDaemon()
if (!docker.ok) {
    console.error(docker.error)
    exitWithError('docker is not reachable — start Docker and run the worker again')
}

const image = await ensureBuildImage(settings.value.limits.image)
if (!image.ok) exitWithError(image.error)

const orphaned = await killOrphanedBuildContainers()
if (!orphaned.ok) exitWithError(orphaned.error)
if (orphaned.value.length > 0) {
    console.log(`berth worker: killed ${orphaned.value.length} build containers left by an earlier run`)
}

clearTrash()
removeBuildScratch()

const db = openDatabase(databasePath())

process.on('SIGINT', () => {
    void stopAndExit(db, 'SIGINT')
})
process.on('SIGTERM', () => {
    void stopAndExit(db, 'SIGTERM')
})

console.log(
    `berth worker: waiting for queued deployments (docker ${docker.value}, image ${settings.value.limits.image})`,
)

await pollUntilStopped(db, settings.value, user.value)
