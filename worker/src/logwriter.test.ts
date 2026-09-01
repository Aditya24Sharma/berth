import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { newDeploymentId, newProjectId, type DeploymentId } from '#shared/ids.ts'
import { loadLogLinesAfter, type LogLine } from '#shared/logs.ts'
import {
    FLUSH_AT_LINES,
    FLUSH_INTERVAL_MS,
    MAX_LINE_LENGTH,
    MAX_LINES_PER_DEPLOYMENT,
    openLogWriter,
    type LogWriter,
} from './logwriter.ts'

function insertProjectAndDeployment(db: DatabaseSync): DeploymentId {
    const projectId = newProjectId()
    const deploymentId = newDeploymentId()

    db.prepare('INSERT INTO projects (id, name, repo_url, build_cmd, output_dir) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, projectId, 'https://example.invalid/site.git', 'npm run build', 'dist')
    db.prepare('INSERT INTO deployments (id, project_id) VALUES (?, ?)').run(deploymentId, projectId)

    return deploymentId
}

type ReadStoredLines = (afterSeq?: number, limit?: number) => readonly LogLine[]

async function withLogWriter(run: (writer: LogWriter, readStored: ReadStoredLines) => void | Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'berth-logwriter-'))
    try {
        const db = openDatabase(join(dir, 'berth.db'))
        const deploymentId = insertProjectAndDeployment(db)
        const writer = openLogWriter(db, deploymentId)

        const readStored: ReadStoredLines = (afterSeq = 0, limit = 1000) => {
            const lines = loadLogLinesAfter(db, deploymentId, afterSeq, limit)
            if (!lines.ok) assert.fail(`expected readable log lines, got ${lines.error}`)
            return lines.value
        }

        try {
            await run(writer, readStored)
        } finally {
            writer.close()
            db.close()
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

function seqsOf(lines: readonly LogLine[]): readonly number[] {
    return lines.map((line) => line.seq)
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

test('a flushed batch carries dense ascending seq from 1', () => {
    return withLogWriter((writer, readStored) => {
        writer.write('stdout', 'installing')
        writer.write('stdout', 'building')
        writer.write('stdout', 'done')
        writer.flush()

        assert.deepEqual(readStored(), [
            { seq: 1, stream: 'stdout', line: 'installing' },
            { seq: 2, stream: 'stdout', line: 'building' },
            { seq: 3, stream: 'stdout', line: 'done' },
        ])
    })
})

test('a written line reaches the database only once something flushes', () => {
    return withLogWriter((writer, readStored) => {
        writer.write('stdout', 'buffered')

        assert.deepEqual(readStored(), [])

        writer.flush()

        assert.deepEqual(seqsOf(readStored()), [1])
    })
})

test('reaching FLUSH_AT_LINES flushes without a timer tick', () => {
    return withLogWriter((writer, readStored) => {
        for (let index = 1; index < FLUSH_AT_LINES; index += 1) {
            writer.write('stdout', `line ${index}`)
        }

        assert.deepEqual(readStored(), [])

        writer.write('stdout', `line ${FLUSH_AT_LINES}`)

        assert.equal(readStored().length, FLUSH_AT_LINES)
    })
})

test('the flush interval writes what is pending with no explicit flush', async () => {
    await withLogWriter(async (writer, readStored) => {
        writer.write('stdout', 'waiting for the timer')
        await sleep(FLUSH_INTERVAL_MS * 4)

        assert.deepEqual(readStored(), [{ seq: 1, stream: 'stdout', line: 'waiting for the timer' }])
    })
})

test('interleaved stdout and stderr lines keep their seq order', () => {
    return withLogWriter((writer, readStored) => {
        writer.write('stdout', 'building')
        writer.write('stderr', 'warning: deprecated')
        writer.write('stdout', 'built')
        writer.write('stderr', 'warning: peer dependency')
        writer.flush()

        assert.deepEqual(readStored(), [
            { seq: 1, stream: 'stdout', line: 'building' },
            { seq: 2, stream: 'stderr', line: 'warning: deprecated' },
            { seq: 3, stream: 'stdout', line: 'built' },
            { seq: 4, stream: 'stderr', line: 'warning: peer dependency' },
        ])
    })
})

test('close flushes what remains and later writes add no rows', () => {
    return withLogWriter((writer, readStored) => {
        writer.write('stdout', 'last real line')
        writer.close()

        assert.deepEqual(seqsOf(readStored()), [1])

        writer.write('stdout', 'after the terminal status')
        writer.flush()

        assert.deepEqual(readStored(), [{ seq: 1, stream: 'stdout', line: 'last real line' }])
    })
})

test('a line over MAX_LINE_LENGTH is stored truncated with a visible marker', () => {
    return withLogWriter((writer, readStored) => {
        writer.write('stdout', 'x'.repeat(MAX_LINE_LENGTH))
        writer.write('stdout', 'y'.repeat(MAX_LINE_LENGTH + 1))
        writer.flush()

        assert.deepEqual(readStored(), [
            { seq: 1, stream: 'stdout', line: 'x'.repeat(MAX_LINE_LENGTH) },
            { seq: 2, stream: 'stdout', line: 'y'.repeat(MAX_LINE_LENGTH) + ' …[line truncated]' },
        ])
    })
})

test('past MAX_LINES_PER_DEPLOYMENT one stderr line names the cap and nothing follows it', () => {
    return withLogWriter((writer, readStored) => {
        for (let index = 1; index <= MAX_LINES_PER_DEPLOYMENT + 5; index += 1) {
            writer.write('stdout', `line ${index}`)
        }
        writer.flush()

        const tail = readStored(MAX_LINES_PER_DEPLOYMENT - 1)

        assert.deepEqual(tail, [
            { seq: MAX_LINES_PER_DEPLOYMENT, stream: 'stdout', line: `line ${MAX_LINES_PER_DEPLOYMENT}` },
            {
                seq: MAX_LINES_PER_DEPLOYMENT + 1,
                stream: 'stderr',
                line: `berth: this build printed more than ${MAX_LINES_PER_DEPLOYMENT} lines; the rest was dropped`,
            },
        ])
    })
})
