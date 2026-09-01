import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseCommitSha, parseRepoUrl, type CommitSha, type RepoUrl } from '#shared/ids.ts'
import type { OutputStream } from '#shared/logs.ts'
import { cloneRepository } from './clone.ts'

const GENEROUS_TIMEOUT_MS = 30000
const IMPATIENT_TIMEOUT_MS = 1500
const MISSING_SHA = 'abcdef0123456789abcdef0123456789abcdef01'

type Delivered = {
    readonly stream: OutputStream
    readonly line: string
}

type CloneRun = {
    readonly commit: CommitSha | null
    readonly error: string | null
    readonly delivered: readonly Delivered[]
    readonly elapsedMs: number
}

type SourceRepo = {
    readonly dir: string
    readonly firstCommit: CommitSha
    readonly headCommit: CommitSha
}

function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8' })
}

function commitShaOf(revParseOutput: string): CommitSha {
    const sha = parseCommitSha(revParseOutput.trim())
    if (sha === null) assert.fail(`${JSON.stringify(revParseOutput)} is not a commit sha`)
    return sha
}

function repoUrlOf(value: string): RepoUrl {
    const url = parseRepoUrl(value)
    if (url === null) assert.fail(`${value} is not a repo url`)
    return url
}

const LOCAL_ORIGIN = repoUrlOf('https://berth.test/fixture.git')

function createSourceRepo(dir: string): SourceRepo {
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '--quiet', dir])
    git(dir, ['config', 'user.email', 'fixture@berth.test'])
    git(dir, ['config', 'user.name', 'berth fixture'])
    // GitHub serves a sha that no ref points at; a plain `git init` repository refuses one
    // unless it is told to, and cloning an explicit commit depends on it.
    git(dir, ['config', 'uploadpack.allowReachableSHA1InWant', 'true'])

    writeFileSync(join(dir, 'index.html'), 'first\n')
    git(dir, ['add', '--all'])
    git(dir, ['commit', '--quiet', '--message', 'first'])
    const firstCommit = commitShaOf(git(dir, ['rev-parse', 'HEAD']))

    writeFileSync(join(dir, 'index.html'), 'second\n')
    git(dir, ['add', '--all'])
    git(dir, ['commit', '--quiet', '--message', 'second'])

    return { dir, firstCommit, headCommit: commitShaOf(git(dir, ['rev-parse', 'HEAD'])) }
}

// A RepoUrl is https by construction, so a repository in a temp directory cannot be named
// by one. Teaching this clone directory to rewrite that one url to the fixture's path lets
// the test drive the real url — the rewrite lives in the clone's local config, which the
// `git init` inside cloneRepository preserves and the neutralised global and system config
// files cannot supply.
function rewriteOriginToLocalRepo(cloneDir: string, sourceDir: string): void {
    mkdirSync(cloneDir, { recursive: true })
    git(cloneDir, ['init', '--quiet', cloneDir])
    git(cloneDir, ['config', `url.${pathToFileURL(sourceDir).href}.insteadOf`, LOCAL_ORIGIN])
}

async function runClone(
    repoUrl: RepoUrl,
    commitSha: CommitSha | null,
    intoDir: string,
    timeoutMs: number,
): Promise<CloneRun> {
    const delivered: Delivered[] = []
    const startedAt = Date.now()

    const cloned = await cloneRepository({
        repoUrl,
        commitSha,
        intoDir,
        timeoutMs,
        onLine: (stream, line) => {
            delivered.push({ stream, line })
        },
    })

    const elapsedMs = Date.now() - startedAt
    if (cloned.ok) return { commit: cloned.value, error: null, delivered, elapsedMs }
    return { commit: null, error: cloned.error, delivered, elapsedMs }
}

function temporaryRoot(): string {
    return mkdtempSync(join(tmpdir(), 'berth-clone-'))
}

function listenOnLoopbackWithoutAnswering(): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
        const sockets: Socket[] = []
        const server: Server = createServer((socket) => {
            sockets.push(socket)
        })

        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (address === null || typeof address === 'string') assert.fail('the listener reported no port')
            resolve({
                port: address.port,
                close: () => {
                    for (const socket of sockets) socket.destroy()
                    server.close()
                },
            })
        })
    })
}

test('a clone with no sha checks out the tip of the default branch', async (t) => {
    const root = temporaryRoot()
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const source = createSourceRepo(join(root, 'source'))
    const cloneDir = join(root, 'repo')
    rewriteOriginToLocalRepo(cloneDir, source.dir)

    const run = await runClone(LOCAL_ORIGIN, null, cloneDir, GENEROUS_TIMEOUT_MS)

    assert.equal(run.error, null)
    assert.equal(run.commit, source.headCommit)
    assert.equal(readFileSync(join(cloneDir, 'index.html'), 'utf8'), 'second\n')
})

test('the returned commit is a parsed sha, not whatever git printed', async (t) => {
    const root = temporaryRoot()
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const source = createSourceRepo(join(root, 'source'))
    const cloneDir = join(root, 'repo')
    rewriteOriginToLocalRepo(cloneDir, source.dir)

    const run = await runClone(LOCAL_ORIGIN, null, cloneDir, GENEROUS_TIMEOUT_MS)

    if (run.commit === null) assert.fail(`expected a commit, got ${run.error}`)
    assert.equal(parseCommitSha(run.commit), run.commit)
})

test('git output reaches the line sink', async (t) => {
    const root = temporaryRoot()
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const source = createSourceRepo(join(root, 'source'))
    const cloneDir = join(root, 'repo')
    rewriteOriginToLocalRepo(cloneDir, source.dir)

    const run = await runClone(LOCAL_ORIGIN, null, cloneDir, GENEROUS_TIMEOUT_MS)

    assert.equal(run.error, null)
    assert.ok(
        run.delivered.some((entry) => entry.line.includes(source.dir)),
        `no delivered line named the fetched repository: ${JSON.stringify(run.delivered)}`,
    )
})

test('a clone with an explicit sha checks out that commit rather than the tip', async (t) => {
    const root = temporaryRoot()
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const source = createSourceRepo(join(root, 'source'))
    const cloneDir = join(root, 'repo')
    rewriteOriginToLocalRepo(cloneDir, source.dir)

    const run = await runClone(LOCAL_ORIGIN, source.firstCommit, cloneDir, GENEROUS_TIMEOUT_MS)

    assert.equal(run.error, null)
    assert.equal(run.commit, source.firstCommit)
    assert.notEqual(source.firstCommit, source.headCommit)
    assert.equal(readFileSync(join(cloneDir, 'index.html'), 'utf8'), 'first\n')
})

test('a sha the repository does not contain fails instead of falling back to the tip', async (t) => {
    const root = temporaryRoot()
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const source = createSourceRepo(join(root, 'source'))
    const cloneDir = join(root, 'repo')
    rewriteOriginToLocalRepo(cloneDir, source.dir)

    const run = await runClone(LOCAL_ORIGIN, commitShaOf(MISSING_SHA), cloneDir, GENEROUS_TIMEOUT_MS)

    assert.equal(run.commit, null)
    assert.match(String(run.error), new RegExp(`could not fetch ${MISSING_SHA} from `))
    assert.equal(existsSync(join(cloneDir, 'index.html')), false)
})

test('a repository url that does not resolve fails long before the timeout', async (t) => {
    const root = temporaryRoot()
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const cloneDir = join(root, 'repo')
    const run = await runClone(
        repoUrlOf('https://berth-does-not-resolve.invalid/fixture.git'),
        null,
        cloneDir,
        GENEROUS_TIMEOUT_MS,
    )

    assert.equal(run.commit, null)
    assert.match(String(run.error), /could not fetch HEAD from https:\/\/berth-does-not-resolve\.invalid/)
    assert.ok(run.elapsedMs < 10000, `the clone took ${run.elapsedMs}ms, which is not a fast failure`)
    assert.ok(run.delivered.length > 0, 'git explained the failure to nobody')
})

test('a server that never answers ends the clone at its timeout', async (t) => {
    const root = temporaryRoot()
    const listener = await listenOnLoopbackWithoutAnswering()
    t.after(() => {
        listener.close()
        rmSync(root, { recursive: true, force: true })
    })

    const cloneDir = join(root, 'repo')
    const run = await runClone(
        repoUrlOf(`https://127.0.0.1:${listener.port}/fixture.git`),
        null,
        cloneDir,
        IMPATIENT_TIMEOUT_MS,
    )

    assert.equal(run.commit, null)
    assert.match(String(run.error), /could not fetch HEAD from https:\/\/127\.0\.0\.1:\d+\/fixture\.git: .*timed out/)
    assert.ok(run.elapsedMs < 10000, `the clone took ${run.elapsedMs}ms, so the timeout did not end it`)
    assert.ok(
        run.delivered.some((entry) => entry.line.includes('berth: the clone timed out')),
        'the log never said why the clone stopped',
    )
})
