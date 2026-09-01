import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import type { Readable } from 'node:stream'
import type { OutputStream } from '#shared/logs.ts'
import { EMPTY_LINE_CARRY, flushPendingLine, splitCompleteLines } from './lines.ts'

export type LineSink = (stream: OutputStream, line: string) => void

export type Exit =
    | { readonly kind: 'exited'; readonly code: number }
    | { readonly kind: 'timedOut'; readonly afterMs: number }
    | { readonly kind: 'spawnFailed'; readonly message: string }

export type SpawnRequest = {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly timeoutMs: number
    readonly maxLineLength: number
    readonly onLine: LineSink
    readonly onTimeout: () => void
}

const KILL_GRACE_MS = 5000
const SIGNAL_EXIT_CODE_BASE = 128

function deliverLines(pipe: Readable, stream: OutputStream, onLine: LineSink, maxLineLength: number): void {
    let carry = EMPTY_LINE_CARRY
    let isDrained = false

    const drain = (): void => {
        if (isDrained) return
        isDrained = true
        for (const line of flushPendingLine(carry, maxLineLength)) onLine(stream, line)
    }

    pipe.setEncoding('utf8')
    pipe.on('data', (chunk: string) => {
        const split = splitCompleteLines(carry, chunk, maxLineLength)
        carry = split.carry
        for (const line of split.lines) onLine(stream, line)
    })
    pipe.on('end', drain)
    pipe.on('error', drain)
}

export function spawnStreamingLines(request: SpawnRequest): Promise<Exit> {
    return new Promise<Exit>((resolve) => {
        const child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            env: { ...request.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        let isSettled = false
        let hasTimedOut = false
        let killAt: ReturnType<typeof setTimeout> | null = null

        const expireAt = setTimeout(() => {
            hasTimedOut = true
            request.onTimeout()
            killAt = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
            killAt.unref()
        }, request.timeoutMs)
        expireAt.unref()

        const settle = (exit: Exit): void => {
            if (isSettled) return
            isSettled = true
            clearTimeout(expireAt)
            if (killAt !== null) clearTimeout(killAt)
            resolve(exit)
        }

        deliverLines(child.stdout, 'stdout', request.onLine, request.maxLineLength)
        deliverLines(child.stderr, 'stderr', request.onLine, request.maxLineLength)

        // ChildProcess reports both a failure to start and a later failure to signal a running
        // child through 'error'. Only the first is fatal here: a child that is alive still owes
        // a 'close', and its exit is the outcome.
        child.on('error', (cause: Error) => {
            if (child.pid === undefined) settle({ kind: 'spawnFailed', message: cause.message })
        })

        child.on('close', (code, signal) => {
            if (hasTimedOut) {
                settle({ kind: 'timedOut', afterMs: request.timeoutMs })
            } else if (code !== null) {
                settle({ kind: 'exited', code })
            } else if (signal !== null) {
                settle({ kind: 'exited', code: SIGNAL_EXIT_CODE_BASE + constants.signals[signal] })
            } else {
                settle({ kind: 'spawnFailed', message: `${request.command} did not start` })
            }
        })
    })
}
