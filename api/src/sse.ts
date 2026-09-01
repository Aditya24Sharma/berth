import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JsonValue } from '#shared/json.ts'

export type SseEvent = {
    readonly id: number | null
    readonly event: string
    readonly data: JsonValue
}

const KEEP_ALIVE_COMMENT = ':keep-alive\n\n'

// A blank line terminates an SSE frame, so a raw newline inside the payload would cut the
// frame in half. JSON.stringify escapes every newline it is given, which is why one data:
// line is always enough — widening `data` beyond JsonValue would reintroduce the problem.
export function encodeSseEvent(event: SseEvent): string {
    const idLine = event.id === null ? '' : `id: ${event.id}\n`
    return `${idLine}event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

export function openEventStream(res: ServerResponse): void {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
    })
    res.flushHeaders()
}

export function sendEvent(res: ServerResponse, event: SseEvent): void {
    res.write(encodeSseEvent(event))
}

export function sendKeepAlive(res: ServerResponse): void {
    res.write(KEEP_ALIVE_COMMENT)
}

export function lastEventId(req: IncomingMessage): number {
    const header = req.headers['last-event-id']
    if (typeof header !== 'string') return 0
    if (!/^[0-9]+$/.test(header)) return 0

    const id = Number(header)
    return Number.isSafeInteger(id) ? id : 0
}
