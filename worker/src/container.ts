import { spawn } from 'node:child_process'
import type { DeploymentId } from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { MAX_LINE_LENGTH } from './logwriter.ts'
import type { ContainerOutcome } from './outcome.ts'
import type { BuildLimits } from './settings.ts'
import { spawnStreamingLines, type Exit, type LineSink } from './subprocess.ts'

export const BUILD_CONTAINER_LABEL = 'berth.deployment'
export const OUTER_TIMEOUT_GRACE_MS = 10_000

const CONTAINER_REPO_DIR = '/berth/repo'
const CONTAINER_SHELL = '/bin/sh'
const BUILD_SHELL_NAME = 'berth-build'
const DEADLINE_SCRIPT = 'exec timeout -s KILL "$1" /bin/sh -c "$2"'

export type BuildContainerPlan = {
    readonly deploymentId: DeploymentId
    readonly repoDir: string
    readonly buildCmd: string
    readonly limits: BuildLimits
    readonly user: string
}

export function containerName(deploymentId: DeploymentId): string {
    return `berth-build-${deploymentId}`
}

export function buildContainerUser(): Parsed<string> {
    if (process.getuid === undefined || process.getgid === undefined) {
        return invalid('the worker cannot read its own uid and gid')
    }
    return valid(`${process.getuid()}:${process.getgid()}`)
}

function containerDeadlineSeconds(timeoutMs: number): string {
    return `${Math.ceil(timeoutMs / 1000)}`
}

export function buildContainerArgs(plan: BuildContainerPlan): readonly string[] {
    const limits = plan.limits
    return [
        'run',
        '--rm',
        '--name', containerName(plan.deploymentId),
        '--label', `${BUILD_CONTAINER_LABEL}=${plan.deploymentId}`,
        '--memory', `${limits.memoryMb}m`,
        // Equal to --memory on purpose: --memory alone implicitly grants swap of the same
        // size again, so a 256m container was measured reaching 500MB before the kernel
        // stepped in. Equal values mean no swap at all.
        '--memory-swap', `${limits.memoryMb}m`,
        '--cpus', `${limits.cpus}`,
        '--pids-limit', `${limits.pidsLimit}`,
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        // Correctness, not tidiness. Without an init as PID 1 the in-container deadline
        // cannot end the container: measured, a 3s deadline left the build running until
        // the outer kill 10s later, and the exit code no longer says a timeout happened.
        '--init',
        '--user', plan.user,
        '--network', limits.network,
        '--tmpfs', `/tmp:rw,exec,nosuid,size=${limits.tmpfsMb}m`,
        '--env', 'HOME=/tmp',
        '--env', 'CI=true',
        '--env', 'npm_config_cache=/tmp/npm-cache',
        '--env', 'npm_config_update_notifier=false',
        '--env', 'npm_config_fund=false',
        '--volume', `${plan.repoDir}:${CONTAINER_REPO_DIR}`,
        '--workdir', CONTAINER_REPO_DIR,
        '--entrypoint', CONTAINER_SHELL,
        limits.image,
        '-c',
        DEADLINE_SCRIPT,
        BUILD_SHELL_NAME,
        containerDeadlineSeconds(limits.timeoutMs),
        plan.buildCmd,
    ]
}

// The container kills itself and the worker also kills it, so an exit code alone cannot
// say which happened — a timeout and an out-of-memory kill both report 137. Elapsed time
// decides, because calling a timeout a memory kill sends a reader hunting a leak that is
// not there.
function containerOutcomeOf(exit: Exit, elapsedMs: number, timeoutMs: number): ContainerOutcome {
    switch (exit.kind) {
        case 'spawnFailed':
            return { kind: 'notStarted', reason: exit.message }
        case 'timedOut':
            return { kind: 'timedOut', afterMs: elapsedMs }
        case 'exited':
            return elapsedMs >= timeoutMs ? { kind: 'timedOut', afterMs: elapsedMs } : { kind: 'exited', code: exit.code }
    }
}

export async function runBuildContainer(plan: BuildContainerPlan, onLine: LineSink): Promise<ContainerOutcome> {
    const startedAt = Date.now()

    const exit = await spawnStreamingLines({
        command: 'docker',
        args: buildContainerArgs(plan),
        cwd: plan.repoDir,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: plan.limits.timeoutMs + OUTER_TIMEOUT_GRACE_MS,
        maxLineLength: MAX_LINE_LENGTH,
        onLine,
        onTimeout: () => {
            void killBuildContainer(plan.deploymentId)
        },
    })

    return containerOutcomeOf(exit, Date.now() - startedAt, plan.limits.timeoutMs)
}

type DockerRun =
    | { readonly kind: 'ran'; readonly code: number; readonly stdout: string; readonly stderr: string }
    | { readonly kind: 'notStarted'; readonly reason: string }

function runDocker(args: readonly string[]): Promise<DockerRun> {
    return new Promise<DockerRun>((resolve) => {
        const child = spawn('docker', [...args], {
            env: { PATH: process.env.PATH ?? '' },
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''
        let isSettled = false

        const settle = (run: DockerRun): void => {
            if (isSettled) return
            isSettled = true
            resolve(run)
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk
        })

        child.on('error', (cause: Error) => {
            if (child.pid === undefined) settle({ kind: 'notStarted', reason: cause.message })
        })

        child.on('close', (code, signal) => {
            if (code !== null) settle({ kind: 'ran', code, stdout, stderr })
            else settle({ kind: 'notStarted', reason: `docker was killed by ${signal ?? 'a signal'}` })
        })
    })
}

function dockerFailure(run: DockerRun, whileDoing: string): string {
    if (run.kind === 'notStarted') return `${whileDoing}: ${run.reason}`
    const detail = run.stderr.trim()
    return detail.length > 0 ? `${whileDoing}: ${detail}` : `${whileDoing}: docker exited with code ${run.code}`
}

// Killing the `docker run` client leaves the container running, because the client is not
// the container. Only the daemon can end it, and only by name.
export async function killBuildContainer(deploymentId: DeploymentId): Promise<void> {
    await runDocker(['kill', '--signal=KILL', containerName(deploymentId)])
}

function nonEmptyLines(output: string): readonly string[] {
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

export async function killOrphanedBuildContainers(): Promise<Parsed<readonly string[]>> {
    const listed = await runDocker(['ps', '-q', '--filter', `label=${BUILD_CONTAINER_LABEL}`])
    if (listed.kind !== 'ran' || listed.code !== 0) {
        return invalid(dockerFailure(listed, 'could not list build containers left by an earlier run'))
    }

    const killed: string[] = []
    for (const id of nonEmptyLines(listed.stdout)) {
        // A container that exited between the listing and the kill is already gone, which
        // is the outcome this wanted, so only the ones actually killed are reported.
        const kill = await runDocker(['kill', '--signal=KILL', id])
        if (kill.kind === 'ran' && kill.code === 0) killed.push(id)
    }
    return valid(killed)
}

export async function checkDockerDaemon(): Promise<Parsed<string>> {
    const run = await runDocker(['version', '--format', '{{.Server.Version}}'])
    if (run.kind !== 'ran' || run.code !== 0) return invalid(dockerFailure(run, 'docker is not reachable'))

    const serverVersion = run.stdout.trim()
    if (serverVersion.length === 0) return invalid('docker is not reachable: it reported no server version')
    return valid(serverVersion)
}

export async function ensureBuildImage(image: string): Promise<Parsed<null>> {
    const inspected = await runDocker(['image', 'inspect', image])
    if (inspected.kind === 'ran' && inspected.code === 0) return valid(null)

    const pulled = await runDocker(['pull', image])
    if (pulled.kind !== 'ran' || pulled.code !== 0) return invalid(dockerFailure(pulled, `could not pull ${image}`))
    return valid(null)
}
