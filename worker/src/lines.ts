export type LineCarry = {
    readonly pending: string
    readonly isTruncated: boolean
}

export type SplitLines = {
    readonly lines: readonly string[]
    readonly carry: LineCarry
}

export const EMPTY_LINE_CARRY: LineCarry = { pending: '', isTruncated: false }

const TRUNCATION_MARKER = ' …[line truncated]'

function withText(carry: LineCarry, text: string, maxLineLength: number): LineCarry {
    if (carry.isTruncated) return carry

    const pending = carry.pending + text
    if (pending.length <= maxLineLength) return { pending, isTruncated: false }
    return { pending: pending.slice(0, maxLineLength), isTruncated: true }
}

function lineFrom(carry: LineCarry, maxLineLength: number): string {
    if (carry.pending.length > maxLineLength) return carry.pending.slice(0, maxLineLength) + TRUNCATION_MARKER
    return carry.isTruncated ? carry.pending + TRUNCATION_MARKER : carry.pending
}

function isHoldingCarriageReturn(carry: LineCarry): boolean {
    return carry.pending.endsWith('\r')
}

function holdingCarriageReturn(carry: LineCarry): LineCarry {
    return { pending: carry.pending + '\r', isTruncated: carry.isTruncated }
}

function withoutHeldCarriageReturn(carry: LineCarry): LineCarry {
    return { pending: carry.pending.slice(0, -1), isTruncated: carry.isTruncated }
}

export function splitCompleteLines(carry: LineCarry, chunk: string, maxLineLength: number): SplitLines {
    if (chunk.length === 0) return { lines: [], carry }

    const lines: string[] = []
    let current = carry
    let index = 0

    if (isHoldingCarriageReturn(current)) {
        lines.push(lineFrom(withoutHeldCarriageReturn(current), maxLineLength))
        current = EMPTY_LINE_CARRY
        if (chunk.startsWith('\n')) index = 1
    }

    let start = index
    while (index < chunk.length) {
        const char = chunk[index]

        // A '\r' ending a chunk is undecided: the next chunk's first character says whether it
        // was a lone break or the first half of a '\r\n'. Holding it costs one chunk of latency;
        // breaking on it emits a phantom empty line for every CRLF that lands on a read boundary.
        if (char === '\r' && index === chunk.length - 1) break

        if (char !== '\n' && char !== '\r') {
            index += 1
            continue
        }

        lines.push(lineFrom(withText(current, chunk.slice(start, index), maxLineLength), maxLineLength))
        current = EMPTY_LINE_CARRY
        index += char === '\r' && chunk[index + 1] === '\n' ? 2 : 1
        start = index
    }

    const rest = chunk.slice(start)
    if (rest.endsWith('\r')) {
        return { lines, carry: holdingCarriageReturn(withText(current, rest.slice(0, -1), maxLineLength)) }
    }
    return { lines, carry: withText(current, rest, maxLineLength) }
}

export function flushPendingLine(carry: LineCarry, maxLineLength: number): readonly string[] {
    const tail = isHoldingCarriageReturn(carry) ? withoutHeldCarriageReturn(carry) : carry
    const line = lineFrom(tail, maxLineLength)
    return line.length === 0 ? [] : [line]
}
