import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { DeploymentId } from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { integerColumn, requiredColumn } from '#shared/columns.ts'

export type OutputStream = 'stdout' | 'stderr'

export type LogLine = {
    readonly seq: number
    readonly stream: OutputStream
    readonly line: string
}

export function parseLogRow(row: Record<string, SQLOutputValue>): Parsed<LogLine> {
    const seq = integerColumn(row.seq, 'seq')
    if (!seq.ok) return seq

    const stream = requiredColumn(row.stream, 'stream')
    if (!stream.ok) return stream

    if (stream.value !== 'stdout' && stream.value !== 'stderr') {
        return invalid(`log stream is not stdout or stderr: ${stream.value}`)
    }

    const line = requiredColumn(row.line, 'line')
    if (!line.ok) return line

    return valid({ seq: seq.value, stream: stream.value, line: line.value })
}

export function appendLogLines(db: DatabaseSync, deploymentId: DeploymentId, lines: readonly LogLine[]): void {
    if (lines.length === 0) return

    const insert = db.prepare('INSERT INTO logs (deployment_id, seq, stream, line) VALUES (?, ?, ?, ?)')

    // BEGIN IMMEDIATE takes the write lock up front. A deferred transaction upgrades a read
    // lock later and can fail with SQLITE_BUSY_SNAPSHOT, which the busy handler does not
    // retry, so busy_timeout would not cover it.
    db.exec('BEGIN IMMEDIATE')
    try {
        for (const { seq, stream, line } of lines) {
            insert.run(deploymentId, seq, stream, line)
        }
        db.exec('COMMIT')
    } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
    }
}

export function loadLogLinesAfter(
    db: DatabaseSync,
    deploymentId: DeploymentId,
    afterSeq: number,
    limit: number,
): Parsed<readonly LogLine[]> {
    const rows = db
        .prepare('SELECT seq, stream, line FROM logs WHERE deployment_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(deploymentId, afterSeq, limit)

    const lines: LogLine[] = []
    for (const row of rows) {
        const parsed = parseLogRow(row)
        if (!parsed.ok) return parsed
        lines.push(parsed.value)
    }

    return valid(lines)
}
