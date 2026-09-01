import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { newDeploymentId, newProjectId, type DeploymentId } from '#shared/ids.ts'
import type { Parsed } from '#shared/json.ts'
import { appendLogLines, loadLogLinesAfter, parseLogRow, type LogLine } from '#shared/logs.ts'

function valueFrom<T>(result: Parsed<T>): T {
    if (!result.ok) assert.fail(`expected a valid result, got ${result.error}`)
    return result.value
}

function errorFrom<T>(result: Parsed<T>): string {
    if (result.ok) assert.fail(`expected an invalid result, got ${JSON.stringify(result.value)}`)
    return result.error
}

function insertProjectAndDeployment(db: DatabaseSync): DeploymentId {
    const projectId = newProjectId()
    const deploymentId = newDeploymentId()

    db.prepare('INSERT INTO projects (id, name, repo_url, build_cmd, output_dir) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, projectId, 'https://example.invalid/site.git', 'npm run build', 'dist')
    db.prepare('INSERT INTO deployments (id, project_id) VALUES (?, ?)').run(deploymentId, projectId)

    return deploymentId
}

function withLogDatabase(run: (db: DatabaseSync, deploymentId: DeploymentId) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'berth-logs-'))
    try {
        const db = openDatabase(join(dir, 'berth.db'))
        try {
            run(db, insertProjectAndDeployment(db))
        } finally {
            db.close()
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

function stdoutLine(seq: number): LogLine {
    return { seq, stream: 'stdout', line: `line ${seq}` }
}

function seqsOf(lines: readonly LogLine[]): readonly number[] {
    return lines.map((line) => line.seq)
}

test('appendLogLines writes a scrambled batch that reads back in seq order', () => {
    withLogDatabase((db, deploymentId) => {
        appendLogLines(db, deploymentId, [stdoutLine(3), stdoutLine(1), stdoutLine(2)])

        assert.deepEqual(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 100)), [
            { seq: 1, stream: 'stdout', line: 'line 1' },
            { seq: 2, stream: 'stdout', line: 'line 2' },
            { seq: 3, stream: 'stdout', line: 'line 3' },
        ])
    })
})

test('appendLogLines keeps each line on the stream that produced it', () => {
    withLogDatabase((db, deploymentId) => {
        appendLogLines(db, deploymentId, [
            { seq: 1, stream: 'stdout', line: 'building' },
            { seq: 2, stream: 'stderr', line: 'warning: deprecated' },
        ])

        assert.deepEqual(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 100)), [
            { seq: 1, stream: 'stdout', line: 'building' },
            { seq: 2, stream: 'stderr', line: 'warning: deprecated' },
        ])
    })
})

test('loadLogLinesAfter takes everything, then the tail, and truncates at the limit', () => {
    withLogDatabase((db, deploymentId) => {
        appendLogLines(db, deploymentId, [1, 2, 3, 4, 5].map(stdoutLine))

        assert.deepEqual(seqsOf(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 100))), [1, 2, 3, 4, 5])
        assert.deepEqual(seqsOf(valueFrom(loadLogLinesAfter(db, deploymentId, 3, 100))), [4, 5])
        assert.deepEqual(seqsOf(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 2))), [1, 2])
        assert.deepEqual(seqsOf(valueFrom(loadLogLinesAfter(db, deploymentId, 5, 100))), [])
    })
})

test('loadLogLinesAfter reads only the deployment it was asked for', () => {
    withLogDatabase((db, deploymentId) => {
        const otherDeploymentId = insertProjectAndDeployment(db)

        appendLogLines(db, deploymentId, [stdoutLine(1)])
        appendLogLines(db, otherDeploymentId, [stdoutLine(1), stdoutLine(2)])

        assert.deepEqual(seqsOf(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 100))), [1])
        assert.deepEqual(seqsOf(valueFrom(loadLogLinesAfter(db, otherDeploymentId, 0, 100))), [1, 2])
    })
})

test('appendLogLines raises on a duplicate seq rather than dropping the line', () => {
    withLogDatabase((db, deploymentId) => {
        appendLogLines(db, deploymentId, [stdoutLine(1)])

        assert.throws(() => appendLogLines(db, deploymentId, [stdoutLine(1)]), /UNIQUE|PRIMARY KEY|constraint/i)
    })
})

test('a batch that raises leaves none of its lines behind', () => {
    withLogDatabase((db, deploymentId) => {
        appendLogLines(db, deploymentId, [stdoutLine(1), stdoutLine(2)])

        assert.throws(() => appendLogLines(db, deploymentId, [stdoutLine(3), stdoutLine(2), stdoutLine(4)]))
        assert.deepEqual(seqsOf(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 100))), [1, 2])
    })
})

test('a raised batch leaves the connection able to write again', () => {
    withLogDatabase((db, deploymentId) => {
        appendLogLines(db, deploymentId, [stdoutLine(1)])
        assert.throws(() => appendLogLines(db, deploymentId, [stdoutLine(1)]))

        appendLogLines(db, deploymentId, [stdoutLine(2)])
        assert.deepEqual(seqsOf(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 100))), [1, 2])
    })
})

test('appendLogLines writes nothing for an empty batch', () => {
    withLogDatabase((db, deploymentId) => {
        appendLogLines(db, deploymentId, [])

        assert.deepEqual(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 100)), [])
    })
})

test('deleting the deployment removes its log rows', () => {
    withLogDatabase((db, deploymentId) => {
        appendLogLines(db, deploymentId, [stdoutLine(1), stdoutLine(2)])
        db.prepare('DELETE FROM deployments WHERE id = ?').run(deploymentId)

        assert.deepEqual(valueFrom(loadLogLinesAfter(db, deploymentId, 0, 100)), [])
    })
})

test('parseLogRow reads a well formed row', () => {
    assert.deepEqual(valueFrom(parseLogRow({ seq: 7n, stream: 'stderr', line: 'boom' })), {
        seq: 7,
        stream: 'stderr',
        line: 'boom',
    })
})

test('parseLogRow keeps an empty line, which a build legitimately prints', () => {
    assert.deepEqual(valueFrom(parseLogRow({ seq: 1n, stream: 'stdout', line: '' })), {
        seq: 1,
        stream: 'stdout',
        line: '',
    })
})

test('parseLogRow rejects a stream outside stdout and stderr', () => {
    assert.equal(
        errorFrom(parseLogRow({ seq: 1n, stream: 'stdin', line: 'boom' })),
        'log stream is not stdout or stderr: stdin',
    )
})

test('parseLogRow rejects a non-integer seq', () => {
    assert.equal(errorFrom(parseLogRow({ seq: 1.5, stream: 'stdout', line: 'boom' })), 'column seq is not an integer')
    assert.equal(errorFrom(parseLogRow({ seq: '1', stream: 'stdout', line: 'boom' })), 'column seq is not an integer')
})

test('parseLogRow rejects a row missing a column', () => {
    assert.equal(errorFrom(parseLogRow({ stream: 'stdout', line: 'boom' })), 'missing column seq')
    assert.equal(errorFrom(parseLogRow({ seq: 1n, line: 'boom' })), 'missing column stream')
    assert.equal(errorFrom(parseLogRow({ seq: 1n, stream: 'stdout' })), 'missing column line')
})
