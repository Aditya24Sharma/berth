import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { encodeSseEvent, lastEventId, openEventStream, sendEvent, sendKeepAlive } from './sse.ts'

type ClientResponse = {
    readonly status: number | undefined
    readonly headers: IncomingHttpHeaders
    readonly body: string
}

async function serveOneRequest(
    serve: (req: IncomingMessage, res: ServerResponse) => void,
    headers: OutgoingHttpHeaders,
): Promise<ClientResponse> {
    const server = createServer(serve)
    try {
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve)
        })

        const address = server.address()
        if (address === null || typeof address === 'string') assert.fail('server did not bind a port')

        const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const clientRequest = request({ host: '127.0.0.1', port: address.port, path: '/', headers }, resolve)
            clientRequest.on('error', reject)
            clientRequest.end()
        })

        const chunks: Buffer[] = []
        for await (const chunk of response) {
            const bytes: Buffer = chunk
            chunks.push(bytes)
        }

        return { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((cause) => {
                if (cause === undefined) resolve()
                else reject(cause)
            })
        })
    }
}

async function lastEventIdReadFrom(header: string | null): Promise<number> {
    const headers: OutgoingHttpHeaders = header === null ? {} : { 'last-event-id': header }
    const response = await serveOneRequest((req, res) => {
        res.end(String(lastEventId(req)))
    }, headers)

    return Number(response.body)
}

test('encodeSseEvent frames an id, an event name and a single-line payload', () => {
    assert.equal(
        encodeSseEvent({ id: 7, event: 'log', data: { line: 'building' } }),
        'id: 7\nevent: log\ndata: {"line":"building"}\n\n',
    )
})

test('encodeSseEvent omits the id line when there is no id', () => {
    assert.equal(encodeSseEvent({ id: null, event: 'status', data: 'ready' }), 'event: status\ndata: "ready"\n\n')
})

test('encodeSseEvent frames an id of zero rather than treating it as absent', () => {
    assert.equal(encodeSseEvent({ id: 0, event: 'log', data: 1 }), 'id: 0\nevent: log\ndata: 1\n\n')
})

test('encodeSseEvent keeps a payload containing a newline on one data line', () => {
    const frame = encodeSseEvent({ id: 1, event: 'log', data: { line: 'first\nsecond' } })

    assert.equal(frame, 'id: 1\nevent: log\ndata: {"line":"first\\nsecond"}\n\n')
    assert.deepEqual(frame.split('\n'), ['id: 1', 'event: log', 'data: {"line":"first\\nsecond"}', '', ''])
})

test('encodeSseEvent keeps a payload containing a carriage return on one data line', () => {
    const frame = encodeSseEvent({ id: 2, event: 'log', data: { line: 'first\r\nsecond' } })

    assert.equal(frame, 'id: 2\nevent: log\ndata: {"line":"first\\r\\nsecond"}\n\n')
    assert.equal(frame.indexOf('\r'), -1)
    assert.deepEqual(frame.split('\n'), ['id: 2', 'event: log', 'data: {"line":"first\\r\\nsecond"}', '', ''])
})

test('encodeSseEvent frames an empty payload', () => {
    assert.equal(encodeSseEvent({ id: 3, event: 'log', data: '' }), 'id: 3\nevent: log\ndata: ""\n\n')
    assert.equal(encodeSseEvent({ id: null, event: 'done', data: {} }), 'event: done\ndata: {}\n\n')
    assert.equal(encodeSseEvent({ id: null, event: 'done', data: null }), 'event: done\ndata: null\n\n')
})

test('encodeSseEvent ends every frame with a blank line', () => {
    for (const frame of [
        encodeSseEvent({ id: null, event: 'a', data: null }),
        encodeSseEvent({ id: 9, event: 'b', data: ['x', 'y'] }),
    ]) {
        assert.ok(frame.endsWith('\n\n'), `frame does not end with a blank line: ${JSON.stringify(frame)}`)
        assert.ok(!frame.endsWith('\n\n\n'), `frame ends with more than one blank line: ${JSON.stringify(frame)}`)
    }
})

test('openEventStream sends the event-stream headers', async () => {
    const response = await serveOneRequest((_req, res) => {
        openEventStream(res)
        res.end()
    }, {})

    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'text/event-stream')
    assert.equal(response.headers['cache-control'], 'no-cache')
    assert.equal(response.headers['connection'], 'keep-alive')
    assert.equal(response.headers['x-accel-buffering'], 'no')
})

test('a live stream carries the keep-alive comment and the frame bytes unchanged', async () => {
    const response = await serveOneRequest((_req, res) => {
        openEventStream(res)
        sendKeepAlive(res)
        sendEvent(res, { id: 4, event: 'log', data: { line: 'one\ntwo' } })
        sendEvent(res, { id: null, event: 'status', data: { status: 'ready' } })
        res.end()
    }, {})

    assert.equal(
        response.body,
        ':keep-alive\n\n' +
            'id: 4\nevent: log\ndata: {"line":"one\\ntwo"}\n\n' +
            'event: status\ndata: {"status":"ready"}\n\n',
    )
})

test('lastEventId reads a non-negative integer header', async () => {
    assert.equal(await lastEventIdReadFrom('42'), 42)
    assert.equal(await lastEventIdReadFrom('0'), 0)
})

test('lastEventId answers zero for anything it cannot trust', async () => {
    assert.equal(await lastEventIdReadFrom(null), 0)
    assert.equal(await lastEventIdReadFrom('banana'), 0)
    assert.equal(await lastEventIdReadFrom('-1'), 0)
    assert.equal(await lastEventIdReadFrom('1.5'), 0)
    assert.equal(await lastEventIdReadFrom(''), 0)
    assert.equal(await lastEventIdReadFrom('0x10'), 0)
    assert.equal(await lastEventIdReadFrom('99999999999999999999'), 0)
})
