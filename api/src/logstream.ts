import type { DatabaseSync } from 'node:sqlite'
import type { ServerResponse } from 'node:http'
import type { DeploymentId } from '#shared/ids.ts'
import type { Deployment } from '#shared/deployments.ts'
import { loadDeployment } from '#shared/deployments.ts'
import { loadLogLinesAfter } from '#shared/logs.ts'
import { sendEvent, sendKeepAlive, type SseEvent } from './sse.ts'

export const KEEP_ALIVE_INTERVAL_MS = 15_000

export type LogStreamOptions = {
    readonly pollIntervalMs: number
    readonly batchLimit: number
    readonly fromSeq: number
}

export type OpenLogStream = {
    readonly close: () => void
}

function isTerminal(deployment: Deployment): boolean {
    return deployment.status === 'ready' || deployment.status === 'failed'
}

export function streamDeploymentLogs(
    db: DatabaseSync,
    res: ServerResponse,
    id: DeploymentId,
    options: LogStreamOptions,
): OpenLogStream {
    let lastSentSeq = options.fromSeq
    let lastWriteAtMs = Date.now()
    let isEnded = false
    let poll: NodeJS.Timeout | null = null

    function stopPolling(): void {
        if (poll === null) return
        clearInterval(poll)
        poll = null
    }

    function send(event: SseEvent): void {
        sendEvent(res, event)
        lastWriteAtMs = Date.now()
    }

    function endWith(event: SseEvent): void {
        stopPolling()
        send(event)
        isEnded = true
        res.end()
    }

    // A terminal status is a promise that every log row already exists, because the worker
    // closes the log writer before it writes the status. Reading the status first is what
    // makes that promise usable: a drain that comes back short afterwards has seen the whole
    // build. Draining first would leave room for a line written between the two reads, which
    // the stream would then end without.
    function pollDatabase(): void {
        const deployment = loadDeployment(db, id)
        if (deployment === null) {
            endWith({ id: null, event: 'error', data: { error: 'no such deployment' } })
            return
        }
        if (!deployment.ok) {
            endWith({ id: null, event: 'error', data: { error: deployment.error } })
            return
        }

        const lines = loadLogLinesAfter(db, id, lastSentSeq, options.batchLimit)
        if (!lines.ok) {
            endWith({ id: null, event: 'error', data: { error: lines.error } })
            return
        }

        for (const line of lines.value) {
            send({ id: line.seq, event: 'log', data: line })
            lastSentSeq = line.seq
        }

        const hasDrainedEveryLine = lines.value.length < options.batchLimit
        if (hasDrainedEveryLine && isTerminal(deployment.value)) {
            endWith({ id: null, event: 'status', data: deployment.value })
            return
        }

        if (Date.now() - lastWriteAtMs >= KEEP_ALIVE_INTERVAL_MS) {
            sendKeepAlive(res)
            lastWriteAtMs = Date.now()
        }
    }

    pollDatabase()
    if (!isEnded) poll = setInterval(pollDatabase, options.pollIntervalMs)

    return { close: stopPolling }
}
