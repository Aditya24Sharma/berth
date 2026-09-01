import type { DatabaseSync } from 'node:sqlite'
import type { BuildingDeployment } from '#shared/deployments.ts'
import { markDeploymentFailed, markDeploymentReady, recordDeploymentCommit } from '#shared/deployments.ts'
import type { CommitSha, DeploymentId } from '#shared/ids.ts'
import type { Parsed } from '#shared/json.ts'
import { clonedRepoDir } from '#shared/paths.ts'
import type { Project } from '#shared/projects.ts'
import { cloneRepository, type CloneRequest } from './clone.ts'
import { runBuildContainer, type BuildContainerPlan } from './container.ts'
import { openLogWriter, type LogWriter } from './logwriter.ts'
import { terminalStatusOf, type ContainerOutcome, type OutputCheck, type TerminalStatus } from './outcome.ts'
import { discardBuildScratch, inspectBuildOutput, publishBuildOutput } from './publish.ts'
import type { BuildLimits } from './settings.ts'
import type { LineSink } from './subprocess.ts'

export type BuildTools = {
    readonly cloneRepository: (request: CloneRequest) => Promise<Parsed<CommitSha>>
    readonly runBuildContainer: (plan: BuildContainerPlan, onLine: LineSink) => Promise<ContainerOutcome>
    readonly inspectBuildOutput: (repoDir: string, outputDir: string) => OutputCheck
    readonly publishBuildOutput: (id: DeploymentId, outputPath: string) => Parsed<string>
    readonly discardBuildScratch: (id: DeploymentId) => void
    readonly openLogWriter: (db: DatabaseSync, id: DeploymentId) => LogWriter
}

export const realBuildTools: BuildTools = {
    cloneRepository,
    runBuildContainer,
    inspectBuildOutput,
    publishBuildOutput,
    discardBuildScratch,
    openLogWriter,
}

function terminalStatusOfPublishedOutput(
    tools: BuildTools,
    id: DeploymentId,
    repoDir: string,
    outputDir: string,
    outcome: ContainerOutcome,
): TerminalStatus {
    let publishError: string | null = null

    const built = terminalStatusOf(outcome, () => {
        const output = tools.inspectBuildOutput(repoDir, outputDir)
        if (output.kind === 'present') {
            const published = tools.publishBuildOutput(id, output.path)
            if (!published.ok) publishError = published.error
        }
        return output
    })

    return publishError === null ? built : { status: 'failed', error: publishError }
}

async function terminalStatusOfClaimedBuild(
    db: DatabaseSync,
    tools: BuildTools,
    limits: BuildLimits,
    cloneTimeoutMs: number,
    user: string,
    deployment: BuildingDeployment,
    project: Project,
    logWriter: LogWriter,
): Promise<TerminalStatus> {
    const repoDir = clonedRepoDir(deployment.id)

    try {
        const cloned = await tools.cloneRepository({
            repoUrl: project.repoUrl,
            commitSha: deployment.commitSha,
            intoDir: repoDir,
            timeoutMs: cloneTimeoutMs,
            onLine: logWriter.write,
        })
        if (!cloned.ok) return { status: 'failed', error: cloned.error }

        if (deployment.commitSha === null) recordDeploymentCommit(db, deployment.id, cloned.value)

        const outcome = await tools.runBuildContainer(
            {
                deploymentId: deployment.id,
                repoDir,
                buildCmd: project.buildCmd,
                limits,
                user,
            },
            logWriter.write,
        )

        return terminalStatusOfPublishedOutput(tools, deployment.id, repoDir, project.outputDir, outcome)
    } catch (cause) {
        return { status: 'failed', error: `the build stopped unexpectedly: ${String(cause)}` }
    }
}

function recordTerminalStatus(db: DatabaseSync, id: DeploymentId, terminal: TerminalStatus): void {
    try {
        const written =
            terminal.status === 'ready' ? markDeploymentReady(db, id) : markDeploymentFailed(db, id, terminal.error)

        if (written === 'ignored') {
            console.error(`berth: ${id} was already finished elsewhere; its ${terminal.status} was not recorded`)
        }
    } catch (cause) {
        console.error(`berth: could not record ${terminal.status} for ${id}: ${String(cause)}`)
    }
}

function closeLogsThenRecordStatus(
    db: DatabaseSync,
    id: DeploymentId,
    logWriter: LogWriter,
    terminal: TerminalStatus,
): void {
    try {
        logWriter.close()
    } catch (cause) {
        console.error(`berth: could not write the last logs of ${id}: ${String(cause)}`)
    }

    recordTerminalStatus(db, id, terminal)
}

function discardBuildScratchReportingFailure(tools: BuildTools, id: DeploymentId): void {
    try {
        tools.discardBuildScratch(id)
    } catch (cause) {
        console.error(`berth: could not remove the build directory of ${id}: ${String(cause)}`)
    }
}

export async function runClaimedBuild(
    db: DatabaseSync,
    tools: BuildTools,
    limits: BuildLimits,
    cloneTimeoutMs: number,
    user: string,
    deployment: BuildingDeployment,
    project: Project,
): Promise<TerminalStatus> {
    try {
        const logWriter = tools.openLogWriter(db, deployment.id)

        const terminal = await terminalStatusOfClaimedBuild(
            db,
            tools,
            limits,
            cloneTimeoutMs,
            user,
            deployment,
            project,
            logWriter,
        )

        if (terminal.status === 'failed') logWriter.write('stderr', `berth: ${terminal.error}`)
        closeLogsThenRecordStatus(db, deployment.id, logWriter, terminal)

        return terminal
    } catch (cause) {
        const terminal: TerminalStatus = { status: 'failed', error: `the build could not be logged: ${String(cause)}` }
        recordTerminalStatus(db, deployment.id, terminal)
        return terminal
    } finally {
        discardBuildScratchReportingFailure(tools, deployment.id)
    }
}
