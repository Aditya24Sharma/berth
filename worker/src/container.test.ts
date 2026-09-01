import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDeploymentId, parseDeploymentId, type DeploymentId } from '#shared/ids.ts'
import type { OutputStream } from '#shared/logs.ts'
import type { ContainerOutcome } from './outcome.ts'
import type { BuildLimits } from './settings.ts'
import {
    buildContainerArgs,
    buildContainerUser,
    checkDockerDaemon,
    containerName,
    ensureBuildImage,
    killOrphanedBuildContainers,
    runBuildContainer,
    type BuildContainerPlan,
} from './container.ts'

const GOLDEN_ID = parseDeploymentId('dpl_0123456789ab')
if (GOLDEN_ID === null) throw new Error('the golden deployment id must parse')

const GOLDEN_LIMITS: BuildLimits = {
    image: 'node:22-alpine',
    memoryMb: 512,
    cpus: 1.5,
    pidsLimit: 64,
    tmpfsMb: 128,
    timeoutMs: 90000,
    network: 'bridge',
}

const GOLDEN_PLAN: BuildContainerPlan = {
    deploymentId: GOLDEN_ID,
    repoDir: '/srv/berth/builds/dpl_0123456789ab/repo',
    buildCmd: 'npm ci && npm run build',
    limits: GOLDEN_LIMITS,
    user: '501:20',
}

test('the argv is exactly this, flag for flag', () => {
    assert.deepEqual(buildContainerArgs(GOLDEN_PLAN), [
        'run',
        '--rm',
        '--name', 'berth-build-dpl_0123456789ab',
        '--label', 'berth.deployment=dpl_0123456789ab',
        '--memory', '512m',
        '--memory-swap', '512m',
        '--cpus', '1.5',
        '--pids-limit', '64',
        '--read-only',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--init',
        '--user', '501:20',
        '--network', 'bridge',
        '--tmpfs', '/tmp:rw,exec,nosuid,size=128m',
        '--env', 'HOME=/tmp',
        '--env', 'CI=true',
        '--env', 'npm_config_cache=/tmp/npm-cache',
        '--env', 'npm_config_update_notifier=false',
        '--env', 'npm_config_fund=false',
        '--volume', '/srv/berth/builds/dpl_0123456789ab/repo:/berth/repo',
        '--workdir', '/berth/repo',
        '--entrypoint', '/bin/sh',
        'node:22-alpine',
        '-c',
        'exec timeout -s KILL "$1" /bin/sh -c "$2"',
        'berth-build',
        '90',
        'npm ci && npm run build',
    ])
})

test('swap is pinned to the memory limit so the real ceiling is not double the stated one', () => {
    const args = buildContainerArgs(GOLDEN_PLAN)
    const memory = args[args.indexOf('--memory') + 1]
    const memorySwap = args[args.indexOf('--memory-swap') + 1]

    assert.equal(memory, '512m')
    assert.equal(memorySwap, memory)
})

test('a hermetic build asks for no network at all', () => {
    const args = buildContainerArgs({ ...GOLDEN_PLAN, limits: { ...GOLDEN_LIMITS, network: 'none' } })

    assert.equal(args[args.indexOf('--network') + 1], 'none')
})

test('the container deadline rounds up to whole seconds', () => {
    const args = buildContainerArgs({ ...GOLDEN_PLAN, limits: { ...GOLDEN_LIMITS, timeoutMs: 1500 } })

    assert.equal(args[args.length - 2], '2')
})

test('neither a tty nor stdin is attached', () => {
    const args = buildContainerArgs(GOLDEN_PLAN)

    assert.equal(args.includes('-t'), false)
    assert.equal(args.includes('-i'), false)
    assert.equal(args.includes('--tty'), false)
    assert.equal(args.includes('--interactive'), false)
})

test('a build command full of shell metacharacters stays one argv element', () => {
    const buildCmd = 'true; rm -rf / && $(id) `whoami` | tee /etc/passwd > "$HOME/x"'
    const args = buildContainerArgs({ ...GOLDEN_PLAN, buildCmd })

    assert.equal(args.filter((arg) => arg === buildCmd).length, 1)
    assert.equal(args[args.length - 1], buildCmd)
    assert.equal(args.filter((arg) => arg !== buildCmd && arg.includes('rm -rf')).length, 0)
    assert.equal(args.filter((arg) => arg !== buildCmd && arg.includes('$(id)')).length, 0)
})

test('a build command that looks like docker flags is never read as docker flags', () => {
    const buildCmd = '--rm -v /:/host --privileged'
    const args = buildContainerArgs({ ...GOLDEN_PLAN, buildCmd })

    assert.equal(args[args.length - 1], buildCmd)
    assert.equal(args.indexOf('--privileged'), -1)
    assert.equal(args.indexOf('-v'), -1)
})

test('the container name is derived from the deployment id so it can be killed by name', () => {
    assert.equal(containerName(GOLDEN_ID), 'berth-build-dpl_0123456789ab')
    assert.equal(buildContainerArgs(GOLDEN_PLAN).includes(containerName(GOLDEN_ID)), true)
})

test('the container user is the worker own uid and gid', () => {
    const user = buildContainerUser()
    assert.equal(user.ok, true)
    if (!user.ok) return

    assert.equal(user.value, `${process.getuid?.()}:${process.getgid?.()}`)
})

const SCRATCH_DIR = mkdtempSync(join(tmpdir(), 'berth-container-'))
const OFF_MOUNT_DIR = mkdtempSync(join(tmpdir(), 'berth-untouchable-'))
const SENTINEL_FILE = join(OFF_MOUNT_DIR, 'sentinel')

writeFileSync(SENTINEL_FILE, 'the host filesystem is not the container filesystem')

test.after(() => {
    rmSync(SCRATCH_DIR, { recursive: true, force: true })
    rmSync(OFF_MOUNT_DIR, { recursive: true, force: true })
})

type BuildRun = {
    readonly outcome: ContainerOutcome
    readonly stdout: readonly string[]
    readonly stderr: readonly string[]
    readonly elapsedMs: number
}

async function runRealBuild(buildCmd: string, limits: Partial<BuildLimits> = {}): Promise<BuildRun> {
    const user = buildContainerUser()
    if (!user.ok) throw new Error(user.error)

    const deploymentId = newDeploymentId()
    const repoDir = mkdtempSync(join(SCRATCH_DIR, `${deploymentId}-`))
    const collected: { readonly stream: OutputStream; readonly line: string }[] = []

    const startedAt = Date.now()
    const outcome = await runBuildContainer(
        { deploymentId, repoDir, buildCmd, limits: { ...GOLDEN_LIMITS, ...limits }, user: user.value },
        (stream, line) => {
            collected.push({ stream, line })
        },
    )

    return {
        outcome,
        stdout: collected.filter((entry) => entry.stream === 'stdout').map((entry) => entry.line),
        stderr: collected.filter((entry) => entry.stream === 'stderr').map((entry) => entry.line),
        elapsedMs: Date.now() - startedAt,
    }
}

test('the docker daemon answers and the build image is available', async () => {
    const daemon = await checkDockerDaemon()
    assert.equal(daemon.ok, true)
    if (!daemon.ok) return
    assert.match(daemon.value, /^\d+\./)

    assert.deepEqual(await ensureBuildImage(GOLDEN_LIMITS.image), { ok: true, value: null })
})

test('an image that does not exist anywhere fails the preflight with a sentence', async () => {
    const missing = await ensureBuildImage('berth-no-such-registry.invalid/nothing:0')

    assert.equal(missing.ok, false)
    if (missing.ok) return
    assert.match(missing.error, /could not pull berth-no-such-registry\.invalid\/nothing:0/)
})

test('a build that succeeds exits zero and its output arrives on the right streams', async () => {
    const run = await runRealBuild('echo built >&1; echo warned >&2; pwd; exit 0')

    assert.deepEqual(run.outcome, { kind: 'exited', code: 0 })
    assert.deepEqual(run.stdout, ['built', '/berth/repo'])
    assert.deepEqual(run.stderr, ['warned'])
})

test('a build that fails reports its own exit code', async () => {
    const run = await runRealBuild('echo nope >&2; exit 3')

    assert.deepEqual(run.outcome, { kind: 'exited', code: 3 })
    assert.deepEqual(run.stderr, ['nope'])
})

test('a build runs as the worker uid inside the container, not as root', async () => {
    const run = await runRealBuild('id -u')

    assert.deepEqual(run.outcome, { kind: 'exited', code: 0 })
    assert.deepEqual(run.stdout, [`${process.getuid?.()}`])
})

test('a build that overruns is killed by the container own deadline and reported as a timeout', async () => {
    const run = await runRealBuild('sleep 60', { timeoutMs: 3000 })

    assert.equal(run.outcome.kind, 'timedOut')
    if (run.outcome.kind !== 'timedOut') return
    assert.ok(run.outcome.afterMs >= 3000, `expected at least the 3s deadline, got ${run.outcome.afterMs}ms`)
    assert.ok(run.elapsedMs < 13000, `the inner deadline should fire long before the outer one, got ${run.elapsedMs}ms`)
})

test('a build that eats memory is killed by the limit and is not mistaken for a timeout', async () => {
    const run = await runRealBuild(
        'node -e "const held=[];for(;;){held.push(Buffer.alloc(8*1024*1024).fill(1))}"',
        { memoryMb: 64, timeoutMs: 120000 },
    )

    assert.deepEqual(run.outcome, { kind: 'exited', code: 137 })
    assert.ok(run.elapsedMs < 60000, `the memory limit should bite quickly, got ${run.elapsedMs}ms`)
})

test('a build command starting with a semicolon reaches the container shell as data, not as a host command', async () => {
    const run = await runRealBuild(`; rm -rf ${OFF_MOUNT_DIR}`)

    assert.deepEqual(run.outcome, { kind: 'exited', code: 2 })
    assert.ok(
        run.stderr.some((line) => line.includes('syntax error')),
        `expected the container shell to reject it, got ${JSON.stringify(run.stderr)}`,
    )
    assert.equal(existsSync(SENTINEL_FILE), true)
})

test('a command substitution is expanded by the container shell and cannot touch the host', async () => {
    const hostFile = join(OFF_MOUNT_DIR, 'pwned')
    const run = await runRealBuild(`echo "mark-$(touch ${hostFile} 2>/dev/null; echo expanded)"`)

    assert.deepEqual(run.outcome, { kind: 'exited', code: 0 })
    assert.deepEqual(run.stdout, ['mark-expanded'])
    assert.equal(existsSync(hostFile), false)
})

test('the label finds a running build container and killing it ends the run', async () => {
    const started = runRealBuild('sleep 120', { timeoutMs: 120000 })

    let killed: readonly string[] = []
    for (let attempt = 0; attempt < 40 && killed.length === 0; attempt += 1) {
        await new Promise((resume) => setTimeout(resume, 500))
        const sweep = await killOrphanedBuildContainers()
        assert.ok(sweep.ok, sweep.ok ? '' : sweep.error)
        killed = sweep.value
    }

    assert.ok(killed.length > 0, 'the label filter found no running build container')

    const run = await started
    assert.equal(run.outcome.kind, 'exited')
    assert.ok(run.elapsedMs < 60000, `the killed container should not have run to its deadline, got ${run.elapsedMs}ms`)
})

test('a docker that cannot be found is reported as a container that never started', async () => {
    const path = process.env.PATH
    process.env.PATH = join(SCRATCH_DIR, 'no-docker-here')
    try {
        const run = await runRealBuild('echo unreachable')
        assert.equal(run.outcome.kind, 'notStarted')
    } finally {
        process.env.PATH = path
    }
})
