import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OutputStream } from '#shared/logs.ts'
import { spawnStreamingLines, type Exit } from './subprocess.ts'

const GENEROUS_LINE_LENGTH = 8192
const GENEROUS_TIMEOUT_MS = 30000
const IMPATIENT_TIMEOUT_MS = 50

type Delivered = {
    readonly stream: OutputStream
    readonly line: string
}

type ChildRun = {
    readonly exit: Exit
    readonly delivered: readonly Delivered[]
    readonly hasCalledOnTimeout: boolean
}

async function runChild(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
    timeoutMs: number,
    maxLineLength: number,
): Promise<ChildRun> {
    const delivered: Delivered[] = []
    let hasCalledOnTimeout = false

    const exit = await spawnStreamingLines({
        command,
        args,
        cwd: tmpdir(),
        env,
        timeoutMs,
        maxLineLength,
        onLine: (stream, line) => {
            delivered.push({ stream, line })
        },
        onTimeout: () => {
            hasCalledOnTimeout = true
        },
    })

    return { exit, delivered, hasCalledOnTimeout }
}

function runScript(script: string): Promise<ChildRun> {
    return runChild(process.execPath, ['-e', script], {}, GENEROUS_TIMEOUT_MS, GENEROUS_LINE_LENGTH)
}

function linesOf(run: ChildRun, stream: OutputStream): readonly string[] {
    return run.delivered.filter((entry) => entry.stream === stream).map((entry) => entry.line)
}

test('lines arrive on the stream that produced them', async () => {
    const run = await runScript(
        'process.stdout.write("installing\\n"); process.stderr.write("deprecated\\n"); process.stdout.write("built\\n")',
    )

    assert.deepEqual(linesOf(run, 'stdout'), ['installing', 'built'])
    assert.deepEqual(linesOf(run, 'stderr'), ['deprecated'])
})

test('a line split across two writes arrives once', async () => {
    const run = await runScript(
        'process.stdout.write("build succ"); setTimeout(() => process.stdout.write("eeded\\n"), 50)',
    )

    assert.deepEqual(linesOf(run, 'stdout'), ['build succeeded'])
})

test('a final line with no trailing newline still arrives', async () => {
    const run = await runScript('process.stdout.write("first\\nno trailing newline")')

    assert.deepEqual(linesOf(run, 'stdout'), ['first', 'no trailing newline'])
})

test('a clean exit resolves with code 0', async () => {
    const run = await runScript('process.stdout.write("ok\\n")')

    assert.deepEqual(run.exit, { kind: 'exited', code: 0 })
    assert.equal(run.hasCalledOnTimeout, false)
})

test('a non-zero exit carries the code', async () => {
    const run = await runScript('process.stderr.write("no build script\\n"); process.exit(3)')

    assert.deepEqual(run.exit, { kind: 'exited', code: 3 })
})

test('a child outliving its timeout resolves timedOut, having called onTimeout', async () => {
    const run = await runChild(
        process.execPath,
        ['-e', 'process.stdout.write("still going\\n"); setTimeout(() => {}, 800)'],
        {},
        IMPATIENT_TIMEOUT_MS,
        GENEROUS_LINE_LENGTH,
    )

    assert.deepEqual(run.exit, { kind: 'timedOut', afterMs: IMPATIENT_TIMEOUT_MS })
    assert.equal(run.hasCalledOnTimeout, true)
    assert.deepEqual(linesOf(run, 'stdout'), ['still going'])
})

test('a child that ignores the timeout is killed and still resolves', async () => {
    const run = await runChild(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        {},
        IMPATIENT_TIMEOUT_MS,
        GENEROUS_LINE_LENGTH,
    )

    assert.deepEqual(run.exit, { kind: 'timedOut', afterMs: IMPATIENT_TIMEOUT_MS })
})

test('a nonexistent command resolves spawnFailed rather than rejecting', async () => {
    const run = await runChild(join(tmpdir(), 'berth-no-such-command'), [], {}, GENEROUS_TIMEOUT_MS, GENEROUS_LINE_LENGTH)

    if (run.exit.kind !== 'spawnFailed') assert.fail(`expected spawnFailed, got ${run.exit.kind}`)
    assert.match(run.exit.message, /ENOENT/)
})

test('the child sees what was passed and nothing it could have inherited', async () => {
    assert.notEqual(process.env.PATH, undefined, 'the parent needs an environment for this to prove anything')

    const run = await runChild(
        process.execPath,
        ['-e', 'console.log(process.env.BERTH_TOKEN); console.log(String(process.env.PATH))'],
        { BERTH_TOKEN: 'sentinel' },
        GENEROUS_TIMEOUT_MS,
        GENEROUS_LINE_LENGTH,
    )

    assert.deepEqual(linesOf(run, 'stdout'), ['sentinel', 'undefined'])
})

test('an argument is never parsed by a shell', async () => {
    const run = await runChild(
        process.execPath,
        ['-e', 'console.log(process.argv.slice(1).join("|"))', '$(echo pwned); rm -rf /', '&& echo also pwned'],
        {},
        GENEROUS_TIMEOUT_MS,
        GENEROUS_LINE_LENGTH,
    )

    assert.deepEqual(linesOf(run, 'stdout'), ['$(echo pwned); rm -rf /|&& echo also pwned'])
})

test('an overlong line is truncated at the requested length', async () => {
    const run = await runChild(
        process.execPath,
        ['-e', 'process.stdout.write("abcdefghijklmnop\\n")'],
        {},
        GENEROUS_TIMEOUT_MS,
        8,
    )

    assert.deepEqual(linesOf(run, 'stdout'), ['abcdefgh …[line truncated]'])
})
