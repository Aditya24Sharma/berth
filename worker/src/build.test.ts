import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '#shared/db.ts'
import {
    claimQueuedDeployment,
    insertQueuedDeployment,
    loadDeployment,
    markDeploymentFailed,
    type BuildingDeployment,
    type Deployment,
} from '#shared/deployments.ts'
import {
    newDeploymentId,
    newProjectId,
    parseCommitSha,
    parseRepoUrl,
    type CommitSha,
    type DeploymentId,
    type ProjectId,
    type RepoUrl,
} from '#shared/ids.ts'
import { valid, type Parsed } from '#shared/json.ts'
import { loadLogLinesAfter, type LogLine } from '#shared/logs.ts'
import { buildScratchDir, clonedRepoDir, deploymentDir } from '#shared/paths.ts'
import { insertProject, loadProject, type CreateProjectBody, type Project } from '#shared/projects.ts'
import { realBuildTools, runClaimedBuild, type BuildTools } from './build.ts'
import { buildContainerUser } from './container.ts'
import { openLogWriter } from './logwriter.ts'
import type { ContainerOutcome, OutputCheck, TerminalStatus } from './outcome.ts'
import type { BuildLimits } from './settings.ts'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'berth-build-'))
process.env.BERTH_DATA_DIR = DATA_DIR

const CLONE_TIMEOUT_MS = 30_000

const LIMITS: BuildLimits = {
    image: 'node:22-alpine',
    memoryMb: 512,
    cpus: 2,
    pidsLimit: 256,
    tmpfsMb: 64,
    timeoutMs: 60_000,
    network: 'none',
}

test.after(() => {
    rmSync(DATA_DIR, { recursive: true, force: true })
})

function repoUrlOf(value: string): RepoUrl {
    const url = parseRepoUrl(value)
    if (url === null) assert.fail(`${value} is not a repo url`)
    return url
}

function commitShaOf(value: string): CommitSha {
    const sha = parseCommitSha(value.trim())
    if (sha === null) assert.fail(`${JSON.stringify(value)} is not a commit sha`)
    return sha
}

const LOCAL_ORIGIN = repoUrlOf('https://berth.test/fixture.git')

function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8' })
}

function createSourceRepo(dir: string): CommitSha {
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '--quiet', dir])
    git(dir, ['config', 'user.email', 'fixture@berth.test'])
    git(dir, ['config', 'user.name', 'berth fixture'])

    writeFileSync(join(dir, 'index.html'), '<h1>berth</h1>\n')
    git(dir, ['add', '--all'])
    git(dir, ['commit', '--quiet', '--message', 'first'])

    return commitShaOf(git(dir, ['rev-parse', 'HEAD']))
}

// A RepoUrl is https by construction, so a repository in a temp directory cannot be named
// by one. The rewrite lives in the clone directory's local config, which the `git init`
// inside cloneRepository preserves, so the build drives the real url end to end.
function rewriteOriginToLocalRepo(cloneDir: string, sourceDir: string): void {
    mkdirSync(cloneDir, { recursive: true })
    git(cloneDir, ['init', '--quiet', cloneDir])
    git(cloneDir, ['config', `url.${pathToFileURL(sourceDir).href}.insteadOf`, LOCAL_ORIGIN])
}

function openTestDatabase(root: string): DatabaseSync {
    return openDatabase(join(root, 'berth.db'))
}

function insertedProject(db: DatabaseSync, body: CreateProjectBody): Project {
    const id = newProjectId()
    insertProject(db, id, body)

    const project = loadProject(db, id)
    if (project === null) assert.fail('the project did not load back')
    if (!project.ok) assert.fail(`the project did not parse: ${project.error}`)
    return project.value
}

function claimedDeployment(db: DatabaseSync, projectId: ProjectId): BuildingDeployment {
    insertQueuedDeployment(db, newDeploymentId(), projectId)

    const claimed = claimQueuedDeployment(db)
    if (claimed === null) assert.fail('there was nothing to claim')
    if (!claimed.ok) assert.fail(`the claim did not parse: ${claimed.error}`)
    return claimed.value
}

function reloaded(db: DatabaseSync, id: DeploymentId): Deployment {
    const deployment = loadDeployment(db, id)
    if (deployment === null) assert.fail(`${id} is not in the database`)
    if (!deployment.ok) assert.fail(`${id} did not parse: ${deployment.error}`)
    return deployment.value
}

function logLinesOf(db: DatabaseSync, id: DeploymentId): readonly LogLine[] {
    const lines = loadLogLinesAfter(db, id, 0, 10_000)
    if (!lines.ok) assert.fail(`the logs did not parse: ${lines.error}`)
    return lines.value
}

function loggedText(db: DatabaseSync, id: DeploymentId): string {
    return logLinesOf(db, id)
        .map((line) => line.line)
        .join('\n')
}

function projectBody(buildCmd: string, outputDir: string): CreateProjectBody {
    return { name: `fixture-${newProjectId()}`, repoUrl: LOCAL_ORIGIN, buildCmd, outputDir }
}

type BuildRecord = {
    containerRuns: number
    inspections: number
    publishes: number
    scratchDiscards: number
    statusWhenLogsClosed: string | null
}

type FakeBuild = {
    readonly cloned: Parsed<CommitSha>
    readonly container: ContainerOutcome | Error
    readonly output: OutputCheck
    readonly published: Parsed<string>
}

function emptyRecord(): BuildRecord {
    return { containerRuns: 0, inspections: 0, publishes: 0, scratchDiscards: 0, statusWhenLogsClosed: null }
}

function fakeBuildTools(script: FakeBuild, record: BuildRecord): BuildTools {
    return {
        cloneRepository: async (request) => {
            request.onLine('stdout', `cloning ${request.repoUrl}`)
            return script.cloned
        },
        runBuildContainer: async (plan, onLine) => {
            record.containerRuns += 1
            onLine('stdout', `running ${plan.buildCmd}`)
            if (script.container instanceof Error) throw script.container
            return script.container
        },
        inspectBuildOutput: () => {
            record.inspections += 1
            return script.output
        },
        publishBuildOutput: () => {
            record.publishes += 1
            return script.published
        },
        discardBuildScratch: (id) => {
            record.scratchDiscards += 1
            realBuildTools.discardBuildScratch(id)
        },
        openLogWriter: (db, id) => {
            const writer = openLogWriter(db, id)
            return {
                write: writer.write,
                flush: writer.flush,
                close: () => {
                    record.statusWhenLogsClosed = reloaded(db, id).status
                    writer.close()
                },
            }
        },
    }
}

const FAKE_SHA = commitShaOf('0123456789abcdef0123456789abcdef01234567')

function successfulScript(id: DeploymentId): FakeBuild {
    return {
        cloned: valid(FAKE_SHA),
        container: { kind: 'exited', code: 0 },
        output: { kind: 'present', path: join(clonedRepoDir(id), 'dist') },
        published: valid(deploymentDir(id)),
    }
}

type FakeRun = {
    readonly terminal: TerminalStatus
    readonly deployment: Deployment
    readonly record: BuildRecord
    readonly db: DatabaseSync
}

async function runWithFakes(t: TestContext, script: (id: DeploymentId) => FakeBuild): Promise<FakeRun> {
    const root = mkdtempSync(join(DATA_DIR, 'fake-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const db = openTestDatabase(root)
    t.after(() => db.close())

    const project = insertedProject(db, projectBody('npm run build', 'dist'))
    const deployment = claimedDeployment(db, project.id)
    const record = emptyRecord()

    const terminal = await runClaimedBuild(
        db,
        fakeBuildTools(script(deployment.id), record),
        LIMITS,
        CLONE_TIMEOUT_MS,
        '0:0',
        deployment,
        project,
    )

    return { terminal, deployment: reloaded(db, deployment.id), record, db }
}

function containerUser(): string {
    const user = buildContainerUser()
    if (!user.ok) assert.fail(user.error)
    return user.value
}

type RealRun = {
    readonly terminal: TerminalStatus
    readonly deployment: Deployment
    readonly headCommit: CommitSha
    readonly db: DatabaseSync
}

async function runAgainstDockerAndGit(t: TestContext, buildCmd: string, outputDir: string): Promise<RealRun> {
    const root = mkdtempSync(join(DATA_DIR, 'real-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const headCommit = createSourceRepo(join(root, 'source'))

    const db = openTestDatabase(root)
    t.after(() => db.close())

    const project = insertedProject(db, projectBody(buildCmd, outputDir))
    const deployment = claimedDeployment(db, project.id)
    rewriteOriginToLocalRepo(clonedRepoDir(deployment.id), join(root, 'source'))

    const terminal = await runClaimedBuild(
        db,
        realBuildTools,
        LIMITS,
        CLONE_TIMEOUT_MS,
        containerUser(),
        deployment,
        project,
    )

    return { terminal, deployment: reloaded(db, deployment.id), headCommit, db }
}

test('a build that clones, runs and publishes ends ready with its output on disk', async (t) => {
    const run = await runAgainstDockerAndGit(t, 'mkdir -p dist && cp index.html dist/ && echo published', 'dist')
    const id = run.deployment.id

    assert.deepEqual(run.terminal, { status: 'ready' })
    assert.equal(run.deployment.status, 'ready')
    assert.equal(run.deployment.commitSha, run.headCommit)
    assert.equal(readFileSync(join(deploymentDir(id), 'index.html'), 'utf8'), '<h1>berth</h1>\n')
    assert.equal(existsSync(buildScratchDir(id)), false)

    const lines = logLinesOf(run.db, id)
    assert.deepEqual(
        lines.map((line) => line.seq),
        lines.map((_, index) => index + 1),
    )
    assert.ok(
        lines.some((line) => line.line === 'published'),
        `the build output is not in the logs: ${loggedText(run.db, id)}`,
    )
})

test('a build command that exits non-zero ends failed with its output still readable', async (t) => {
    const run = await runAgainstDockerAndGit(t, 'echo compiling; echo no build script >&2; exit 3', 'dist')
    const id = run.deployment.id

    assert.deepEqual(run.terminal, { status: 'failed', error: 'the build exited with code 3' })
    if (run.deployment.status !== 'failed') assert.fail(`expected failed, got ${run.deployment.status}`)
    assert.equal(run.deployment.error, 'the build exited with code 3')
    assert.equal(existsSync(deploymentDir(id)), false)
    assert.equal(existsSync(buildScratchDir(id)), false)

    const lines = logLinesOf(run.db, id)
    assert.ok(
        lines.some((line) => line.stream === 'stdout' && line.line === 'compiling'),
        `the build stdout is not in the logs: ${loggedText(run.db, id)}`,
    )
    assert.ok(
        lines.some((line) => line.stream === 'stderr' && line.line === 'no build script'),
        `the build stderr is not in the logs: ${loggedText(run.db, id)}`,
    )
    assert.ok(
        lines.some((line) => line.line === 'berth: the build exited with code 3'),
        `the failure is not in the logs: ${loggedText(run.db, id)}`,
    )
})

test('a build that exits zero without writing its output directory ends failed', async (t) => {
    const run = await runAgainstDockerAndGit(t, 'echo nothing to do', 'dist')
    const id = run.deployment.id

    if (run.terminal.status !== 'failed') assert.fail('expected a failed build')
    assert.match(run.terminal.error, /^the build produced no output directory at .*\/repo\/dist$/)
    assert.equal(reloaded(run.db, id).status, 'failed')
    assert.equal(existsSync(deploymentDir(id)), false)
    assert.equal(existsSync(buildScratchDir(id)), false)
})

test('a failed clone fails the deployment without ever starting a container', async (t) => {
    const run = await runWithFakes(t, (id) => ({
        ...successfulScript(id),
        cloned: { ok: false, error: 'could not fetch HEAD from https://berth.test/fixture.git' },
    }))

    assert.deepEqual(run.terminal, {
        status: 'failed',
        error: 'could not fetch HEAD from https://berth.test/fixture.git',
    })
    assert.equal(run.deployment.status, 'failed')
    assert.equal(run.record.containerRuns, 0)
    assert.equal(run.record.inspections, 0)
    assert.equal(run.record.publishes, 0)
    assert.equal(run.record.scratchDiscards, 1)
    assert.ok(
        loggedText(run.db, run.deployment.id).includes(
            'berth: could not fetch HEAD from https://berth.test/fixture.git',
        ),
        'the clone failure is not in the logs',
    )
})

test('a build that times out fails without looking at its output', async (t) => {
    const run = await runWithFakes(t, (id) => ({
        ...successfulScript(id),
        container: { kind: 'timedOut', afterMs: 600_000 },
    }))

    assert.deepEqual(run.terminal, { status: 'failed', error: 'the build timed out after 600 seconds' })
    assert.equal(run.deployment.status, 'failed')
    assert.equal(run.record.inspections, 0)
    assert.equal(run.record.publishes, 0)
    assert.equal(run.record.scratchDiscards, 1)
})

test('an output directory that resolves outside the clone fails and publishes nothing', async (t) => {
    const run = await runWithFakes(t, (id) => ({
        ...successfulScript(id),
        output: { kind: 'escapesRepo', outputDir: '../..' },
    }))

    assert.deepEqual(run.terminal, {
        status: 'failed',
        error: 'the output directory ../.. resolves outside the repository',
    })
    assert.equal(run.deployment.status, 'failed')
    assert.equal(run.record.publishes, 0)
    assert.equal(run.record.scratchDiscards, 1)
})

test('a publish that fails leaves the deployment failed rather than ready', async (t) => {
    const run = await runWithFakes(t, (id) => ({
        ...successfulScript(id),
        published: { ok: false, error: 'a deployment directory already exists for this id' },
    }))

    assert.deepEqual(run.terminal, {
        status: 'failed',
        error: 'a deployment directory already exists for this id',
    })
    assert.equal(run.deployment.status, 'failed')
    assert.equal(run.record.publishes, 1)
    assert.equal(run.record.scratchDiscards, 1)
})

test('a tool that throws fails the deployment instead of rejecting', async (t) => {
    const run = await runWithFakes(t, (id) => ({
        ...successfulScript(id),
        container: new Error('docker is not reachable'),
    }))

    if (run.terminal.status !== 'failed') assert.fail('expected a failed build')
    assert.match(run.terminal.error, /^the build stopped unexpectedly: Error: docker is not reachable$/)
    if (run.deployment.status !== 'failed') assert.fail(`expected failed, got ${run.deployment.status}`)
    assert.equal(run.deployment.error, run.terminal.error)
    assert.equal(run.record.scratchDiscards, 1)
    assert.ok(
        loggedText(run.db, run.deployment.id).includes('berth: the build stopped unexpectedly'),
        'the unexpected failure is not in the logs',
    )
})

test('the resolved commit is recorded for a deployment queued without one', async (t) => {
    const run = await runWithFakes(t, (id) => successfulScript(id))

    assert.deepEqual(run.terminal, { status: 'ready' })
    assert.equal(run.deployment.commitSha, FAKE_SHA)
})

test('the logs are closed before the status becomes terminal', async (t) => {
    const run = await runWithFakes(t, (id) => successfulScript(id))

    assert.equal(run.record.statusWhenLogsClosed, 'building')
    assert.equal(run.deployment.status, 'ready')
})

test('a deployment finished by something else keeps that outcome', async (t) => {
    const root = mkdtempSync(join(DATA_DIR, 'raced-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const db = openTestDatabase(root)
    t.after(() => db.close())

    const project = insertedProject(db, projectBody('npm run build', 'dist'))
    const deployment = claimedDeployment(db, project.id)
    const record = emptyRecord()

    assert.equal(markDeploymentFailed(db, deployment.id, 'the abandoned sweep failed it'), 'applied')

    const terminal = await runClaimedBuild(
        db,
        fakeBuildTools(successfulScript(deployment.id), record),
        LIMITS,
        CLONE_TIMEOUT_MS,
        '0:0',
        deployment,
        project,
    )

    assert.deepEqual(terminal, { status: 'ready' })

    const finished = reloaded(db, deployment.id)
    if (finished.status !== 'failed') assert.fail(`expected failed, got ${finished.status}`)
    assert.equal(finished.error, 'the abandoned sweep failed it')
    assert.equal(record.scratchDiscards, 1)
})
