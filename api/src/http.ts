import type { IncomingMessage, ServerResponse } from 'node:http'
import type { JsonValue, Parsed } from './json.ts'
import { invalid, valid } from './json.ts'

const MAX_BODY_BYTES = 64 * 1024

export async function readJsonBody(req: IncomingMessage): Promise<Parsed<JsonValue>> {
    const chunks: Buffer[] = []
    let received = 0

    for await (const chunk of req) {
        const bytes: Buffer = chunk
        received += bytes.length
        if (received > MAX_BODY_BYTES) return invalid('request body is too large')
        chunks.push(bytes)
    }

    try {
        const body: JsonValue = JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
