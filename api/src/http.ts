import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JsonValue, Parsed } from '#shared/json.ts'
import { invalid, valid } from '#shared/json.ts'

export const MAX_BODY_BYTES = 64 * 1024

export async function readBody(req: IncomingMessage): Promise<Parsed<Buffer>> {
    const chunks: Buffer[] = []
    let received = 0

    for await (const chunk of req) {
        const bytes: Buffer = chunk
        received += bytes.length
        if (received > MAX_BODY_BYTES) return invalid('request body is too large')
        chunks.push(bytes)
    }

    return valid(Buffer.concat(chunks))
}

export function parseJsonBody(raw: Buffer): Parsed<JsonValue> {
    if (raw.length === 0) return valid({})

    try {
        const body: JsonValue = JSON.parse(raw.toString('utf8'))
        return valid(body)
    } catch {
        return invalid('request body is not valid JSON')
    }
}

export function sendJson(res: ServerResponse, status: number, body: JsonValue): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
}

export function sendError(res: ServerResponse, status: number, error: string): void {
    sendJson(res, status, { error })
}
