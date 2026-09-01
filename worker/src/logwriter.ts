import type { DatabaseSync } from 'node:sqlite'
import type { DeploymentId } from '#shared/ids.ts'
import { appendLogLines, type LogLine, type OutputStream } from '#shared/logs.ts'

export type LogWriter = {
    readonly write: (stream: OutputStream, line: string) => void
    readonly flush: () => void
    readonly close: () => void
}

export const FLUSH_INTERVAL_MS = 250
export const FLUSH_AT_LINES = 200
export const MAX_LINE_LENGTH = 8192
export const MAX_LINES_PER_DEPLOYMENT = 50_000

const TRUNCATION_MARKER = ' …[line truncated]'

const LINE_CAP_MESSAGE = `berth: this build printed more than ${MAX_LINES_PER_DEPLOYMENT} lines; the rest was dropped`

type WriterState = 'accepting' | 'capped' | 'closed'

function truncatedToMaxLength(line: string): string {
    if (line.length <= MAX_LINE_LENGTH) return line
    return line.slice(0, MAX_LINE_LENGTH) + TRUNCATION_MARKER
}

export function openLogWriter(db: DatabaseSync, deploymentId: DeploymentId): LogWriter {
    const pending: LogLine[] = []
    let seq = 0
    let state: WriterState = 'accepting'

    function flush(): void {
        if (pending.length === 0) return
        appendLogLines(db, deploymentId, pending)
        pending.length = 0
    }

    function record(stream: OutputStream, line: string): void {
        seq += 1
        pending.push({ seq, stream, line })
        if (pending.length >= FLUSH_AT_LINES) flush()
    }

    function write(stream: OutputStream, line: string): void {
        if (state !== 'accepting') return

        if (seq === MAX_LINES_PER_DEPLOYMENT) {
            state = 'capped'
            record('stderr', LINE_CAP_MESSAGE)
            return
        }

        record(stream, truncatedToMaxLength(line))
    }

    function close(): void {
        clearInterval(timer)
        state = 'closed'
        flush()
    }

    // SQLite serialises writers; log lines batch so a noisy build cannot starve the
    // status update that ends it.
    const timer = setInterval(flush, FLUSH_INTERVAL_MS)
    timer.unref()

    return { write, flush, close }
}
