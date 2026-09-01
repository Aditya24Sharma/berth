import { mkdirSync } from 'node:fs'
import { parseCommitSha, type CommitSha, type RepoUrl } from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { MAX_LINE_LENGTH } from './logwriter.ts'
import { spawnStreamingLines, type Exit, type LineSink } from './subprocess.ts'

export type CloneRequest = {
    readonly repoUrl: RepoUrl
    readonly commitSha: CommitSha | null
    readonly intoDir: string
    readonly timeoutMs: number
    readonly onLine: LineSink
}

const GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
    PATH: process.env.PATH ?? '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
}

function secondsOf(milliseconds: number): number {
    return Math.round(milliseconds / 1000)
}

function timedOutAfter(milliseconds: number): Promise<Exit> {
    return new Promise<Exit>((resolve) => {
        const expireAt = setTimeout(() => resolve({ kind: 'timedOut', afterMs: milliseconds }), milliseconds)
        expireAt.unref()
    })
}

function createCloneDirectory(intoDir: string): Parsed<null> {
    try {
        mkdirSync(intoDir, { recursive: true })
    } catch (error) {
        if (!(error instanceof Error)) throw error
        return invalid(`could not create the clone directory ${intoDir}: ${error.message}`)
    }
    return valid(null)
}

function clonedCommitOf(revParseOutput: readonly string[]): Parsed<CommitSha> {
    const printed = revParseOutput[0]
    if (revParseOutput.length !== 1 || printed === undefined) {
        return invalid(`git rev-parse HEAD printed ${revParseOutput.length} lines instead of one`)
    }

    const sha = parseCommitSha(printed)
    if (sha === null) return invalid(`git rev-parse HEAD printed ${JSON.stringify(printed)}, which is not a commit sha`)
    return valid(sha)
}

export async function cloneRepository(request: CloneRequest): Promise<Parsed<CommitSha>> {
    const created = createCloneDirectory(request.intoDir)
    if (!created.ok) return created

    const expireAt = Date.now() + request.timeoutMs
    const timedOut = `the clone timed out after ${secondsOf(request.timeoutMs)} seconds`

    async function runGit(operation: string, args: readonly string[]): Promise<Parsed<readonly string[]>> {
        const remainingMs = expireAt - Date.now()
        if (remainingMs <= 0) return invalid(`could not ${operation}: ${timedOut}`)

        const printed: string[] = []
        const running = spawnStreamingLines({
            command: 'git',
            args,
            cwd: request.intoDir,
            env: GIT_ENVIRONMENT,
            timeoutMs: remainingMs,
            maxLineLength: MAX_LINE_LENGTH,
            onLine: (stream, line) => {
                if (stream === 'stdout') printed.push(line)
                request.onLine(stream, line)
            },
            onTimeout: () => request.onLine('stderr', `berth: ${timedOut}`),
        })

        // git delegates https to a `git-remote-https` grandchild that outlives the signals
        // sent to git itself and keeps holding the pipes, so against a server that accepts a
        // connection and then answers nothing the child never closes. The deadline is the
        // clone's to keep, not the child's.
        const exit = await Promise.race([running, timedOutAfter(remainingMs)])

        switch (exit.kind) {
            case 'exited':
                if (exit.code === 0) return valid(printed)
                return invalid(`could not ${operation}: git exited with code ${exit.code}`)
            case 'timedOut':
                return invalid(`could not ${operation}: ${timedOut}`)
            case 'spawnFailed':
                return invalid(`could not ${operation}: git did not start: ${exit.message}`)
        }
    }

    const dir = request.intoDir
    const ref = request.commitSha ?? 'HEAD'

    const initialised = await runGit('create the clone directory', ['init', '--quiet', dir])
    if (!initialised.ok) return initialised

    const pointed = await runGit(`point the clone at ${request.repoUrl}`, [
        '-C', dir, 'remote', 'add', 'origin', request.repoUrl,
    ])
    if (!pointed.ok) return pointed

    // Naming a sha in a fetch relies on the server allowing reachable-SHA1-in-want, which
    // GitHub does; that is what lets an exact commit and the latest HEAD share one shallow
    // fetch instead of needing a full clone.
    const fetched = await runGit(`fetch ${ref} from ${request.repoUrl}`, [
        '-C', dir, 'fetch', '--depth', '1', '--no-tags', 'origin', ref,
    ])
    if (!fetched.ok) return fetched

    const checkedOut = await runGit('check out the fetched commit', [
        '-C', dir, 'checkout', '--detach', '--quiet', 'FETCH_HEAD',
    ])
    if (!checkedOut.ok) return checkedOut

    const resolved = await runGit('read the cloned commit', ['-C', dir, 'rev-parse', 'HEAD'])
    if (!resolved.ok) return resolved

    return clonedCommitOf(resolved.value)
}
