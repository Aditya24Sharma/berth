import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { openDatabase } from '#shared/db.ts'
import {
    claimQueuedDeployment,
    insertQueuedDeployment,
    markDeploymentFailed,
    markDeploymentReady,
} from '#shared/deployments.ts'
import { newDeploymentId, newProjectId, type DeploymentId } from '#shared/ids.ts'
import { isJsonObject, type JsonValue } from '#shared/json.ts'
import { appendLogLines, type LogLine } from '#shared/logs.ts'
import {
    KEEP_ALIVE_INTERVAL_MS,
    streamDeploymentLogs,
    type LogStreamOptions,
    type OpenLogStream,
} from './logstream.ts'

class RecordingResponse extends ServerResponse {
    readonly frames: string[] = []
    endCount = 0

    constructor() {
        super(new IncomingMessage(new Socket()))
    }

    override write(chunk: string): boolean {
        this.frames.push(chunk)
        return true
    }

    override end(): this {
        this.endCount += 1
        return this
    }
}

type Fixture = {
    readonly db: DatabaseSync
    readonly deploymentId: DeploymentId
    readonly openStream: (res: RecordingResponse, options: LogStreamOptions) => OpenLogStream
}

function openBuildingFixture(t: TestContext): Fixture {
    const dir = mkdtempSync(join(tmpdir(), 'berth-logstream-'))
    const db = openDatabase(join(dir, 'berth.db'))
    const projectId = newProjectId()
    const deploymentId = newDeploymentId()

    db.prepare('INSERT INTO projects (id, name, repo_url, build_cmd, output_dir) VALUES (?, ?, ?, ?, ?)').run(
        projectId,
        projectId,
        'https://example.invalid/site.git',
        'npm run build',
        'dist',
    )
    insertQueuedDeployment(db, deploymentId, projectId)

    const claimed = claimQueuedDeployment(db)
    if (claimed === null) assert.fail('the queued deployment was not claimable')
    if (!claimed.ok) assert.fail(claimed.error)

    const streams: OpenLogStream[] = []

    t.after(() => {
        for (const stream of streams) stream.close()
        db.close()
        rmSync(dir, { recursive: true, force: true })
    })

    return {
        db,
        deploymentId,
        openStream: (res, options) => {
            const stream = streamDeploymentLogs(db, res, deploymentId, options)
            streams.push(stream)
            return stream
        },
    }
}

function appendBuildLines(db: DatabaseSync, id: DeploymentId, texts: readonly string[], fromSeq = 1): void {
    appendLogLines(
        db,
        id,
        texts.map((line, index): LogLine => ({ seq: fromSeq + index, stream: 'stdout', line })),
    )
}

function logFrame(seq: number, line: string): string {
    return `id: ${seq}\nevent: log\ndata: ${JSON.stringify({ seq, stream: 'stdout', line })}\n\n`
}

function frameAt(res: RecordingResponse, index: number): string {
    const frame = res.frames[index]
    if (frame === undefined) assert.fail(`expected a frame at index ${index}, got ${res.frames.length} frames`)
    return frame
}

function deploymentInStatusFrame(frame: string): { readonly [key: string]: JsonValue } {
    const prefix = 'event: status\ndata: '
    if (!frame.startsWith(prefix)) assert.fail(`not a status frame: ${JSON.stringify(frame)}`)
    if (!frame.endsWith('\n\n')) assert.fail(`status frame does not end a frame: ${JSON.stringify(frame)}`)

    const payload: JsonValue = JSON.parse(frame.slice(prefix.length, -2))
    if (!isJsonObject(payload)) assert.fail(`status frame payload is not an object: ${JSON.stringify(frame)}`)
    return payload
}

async function waitUntil(isSatisfied: () => boolean, note: string): Promise<void> {
    const deadline = Date.now() + 2000
    while (!isSatisfied()) {
        if (Date.now() >= deadline) assert.fail(`timed out waiting until ${note}`)
        await delay(2)
    }
}

test('sends the lines that already exist, each framed with its seq as the event id', (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)
    appendBuildLines(db, deploymentId, ['one', 'two', 'three'])

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 1, batchLimit: 500, fromSeq: 0 })

    assert.deepEqual(res.frames, [
        'id: 1\nevent: log\ndata: {"seq":1,"stream":"stdout","line":"one"}\n\n',
        'id: 2\nevent: log\ndata: {"seq":2,"stream":"stdout","line":"two"}\n\n',
        'id: 3\nevent: log\ndata: {"seq":3,"stream":"stdout","line":"three"}\n\n',
    ])
    assert.equal(res.endCount, 0)
})

test('writes nothing on a poll that finds no new lines', async (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)
    appendBuildLines(db, deploymentId, ['one', 'two'])

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 1, batchLimit: 500, fromSeq: 0 })
    assert.equal(res.frames.length, 2)

    await delay(40)

    assert.deepEqual(res.frames, [logFrame(1, 'one'), logFrame(2, 'two')])
    assert.equal(res.endCount, 0)
})

test('sends lines as they arrive and ends on the terminal status', async (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 1, batchLimit: 500, fromSeq: 0 })
    assert.deepEqual(res.frames, [])

    appendBuildLines(db, deploymentId, ['compiling'])
    await waitUntil(() => res.frames.length === 1, 'the new line is sent')
    assert.equal(frameAt(res, 0), logFrame(1, 'compiling'))
    assert.equal(res.endCount, 0)

    assert.equal(markDeploymentReady(db, deploymentId), 'applied')
    await waitUntil(() => res.endCount === 1, 'the stream ends')

    assert.equal(res.frames.length, 2)
    assert.equal(deploymentInStatusFrame(frameAt(res, 1))['status'], 'ready')

    appendBuildLines(db, deploymentId, ['late'], 2)
    await delay(40)

    assert.equal(res.frames.length, 2)
    assert.equal(res.endCount, 1)
})

test('a stream opened on a finished deployment sends the backlog and ends without waiting for a poll', async (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)
    appendBuildLines(db, deploymentId, ['one', 'two', 'three'])
    assert.equal(markDeploymentReady(db, deploymentId), 'applied')

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 60_000, batchLimit: 500, fromSeq: 0 })

    assert.deepEqual(res.frames.slice(0, 3), [logFrame(1, 'one'), logFrame(2, 'two'), logFrame(3, 'three')])
    assert.equal(res.frames.length, 4)
    assert.equal(deploymentInStatusFrame(frameAt(res, 3))['status'], 'ready')
    assert.equal(res.endCount, 1)

    await delay(40)

    assert.equal(res.frames.length, 4)
    assert.equal(res.endCount, 1)
})

test('resumes after the seq the client already received', (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)
    appendBuildLines(db, deploymentId, ['one', 'two', 'three'])
    assert.equal(markDeploymentReady(db, deploymentId), 'applied')

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 60_000, batchLimit: 500, fromSeq: 2 })

    assert.equal(res.frames.length, 2)
    assert.equal(frameAt(res, 0), logFrame(3, 'three'))
    assert.equal(deploymentInStatusFrame(frameAt(res, 1))['status'], 'ready')
    assert.equal(res.endCount, 1)
})

test('close stops the poll and nothing is written afterwards', async (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)
    appendBuildLines(db, deploymentId, ['one'])

    const res = new RecordingResponse()
    const stream = openStream(res, { pollIntervalMs: 1, batchLimit: 500, fromSeq: 0 })
    assert.equal(res.frames.length, 1)

    stream.close()
    appendBuildLines(db, deploymentId, ['two', 'three'], 2)
    assert.equal(markDeploymentReady(db, deploymentId), 'applied')
    await delay(40)

    assert.deepEqual(res.frames, [logFrame(1, 'one')])
    assert.equal(res.endCount, 0)
})

test('a failed build ends with its error in the status frame', (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)
    appendBuildLines(db, deploymentId, ['boom'])
    assert.equal(markDeploymentFailed(db, deploymentId, 'build exited 1'), 'applied')

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 60_000, batchLimit: 500, fromSeq: 0 })

    assert.equal(res.frames.length, 2)
    const deployment = deploymentInStatusFrame(frameAt(res, 1))
    assert.equal(deployment['status'], 'failed')
    assert.equal(deployment['error'], 'build exited 1')
    assert.equal(res.endCount, 1)
})

test('sends every line of a finished build before the status frame even when a batch fills', async (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)
    appendBuildLines(db, deploymentId, ['one', 'two', 'three', 'four', 'five'])
    assert.equal(markDeploymentReady(db, deploymentId), 'applied')

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 1, batchLimit: 2, fromSeq: 0 })
    await waitUntil(() => res.endCount === 1, 'the stream ends')

    assert.deepEqual(res.frames.slice(0, 5), [
        logFrame(1, 'one'),
        logFrame(2, 'two'),
        logFrame(3, 'three'),
        logFrame(4, 'four'),
        logFrame(5, 'five'),
    ])
    assert.equal(res.frames.length, 6)
    assert.equal(deploymentInStatusFrame(frameAt(res, 5))['status'], 'ready')
})

test('keeps a quiet stream alive with a comment every fifteen seconds', (t) => {
    const { openStream } = openBuildingFixture(t)
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] })

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 1000, batchLimit: 500, fromSeq: 0 })

    t.mock.timers.tick(KEEP_ALIVE_INTERVAL_MS - 1000)
    assert.deepEqual(res.frames, [])

    t.mock.timers.tick(1000)
    assert.deepEqual(res.frames, [':keep-alive\n\n'])

    t.mock.timers.tick(KEEP_ALIVE_INTERVAL_MS)
    assert.deepEqual(res.frames, [':keep-alive\n\n', ':keep-alive\n\n'])
    assert.equal(res.endCount, 0)
})

// The losing interleaving is a line written between the two reads of a poll, which is not
// reachable from the test's own thread: a poll runs to completion without yielding. Patching
// prepare puts the write inside that window, so a stream that read the status after the logs
// would end without the line.
function appendLineBeforeNextDeploymentRead(db: DatabaseSync, id: DeploymentId, line: LogLine): void {
    const prepare = db.prepare.bind(db)
    let hasFired = false

    db.prepare = (sql, options) => {
        if (!hasFired && sql.includes('FROM deployments')) {
            hasFired = true
            appendLogLines(db, id, [line])
        }
        return prepare(sql, options)
    }
}

test('sends a line that lands mid-poll before ending on the terminal status', (t) => {
    const { db, deploymentId, openStream } = openBuildingFixture(t)
    appendBuildLines(db, deploymentId, ['one'])
    assert.equal(markDeploymentReady(db, deploymentId), 'applied')
    appendLineBeforeNextDeploymentRead(db, deploymentId, { seq: 2, stream: 'stdout', line: 'two' })

    const res = new RecordingResponse()
    openStream(res, { pollIntervalMs: 60_000, batchLimit: 500, fromSeq: 0 })

    assert.deepEqual(res.frames.slice(0, 2), [logFrame(1, 'one'), logFrame(2, 'two')])
    assert.equal(res.frames.length, 3)
    assert.equal(deploymentInStatusFrame(frameAt(res, 2))['status'], 'ready')
    assert.equal(res.endCount, 1)
})
