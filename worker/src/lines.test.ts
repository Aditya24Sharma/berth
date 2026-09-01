import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LINE_CARRY, flushPendingLine, splitCompleteLines, type LineCarry } from './lines.ts'

const GENEROUS_LINE_LENGTH = 8192

function linesFromChunks(chunks: readonly string[], maxLineLength: number): readonly string[] {
    const lines: string[] = []
    let carry = EMPTY_LINE_CARRY

    for (const chunk of chunks) {
        const split = splitCompleteLines(carry, chunk, maxLineLength)
        lines.push(...split.lines)
        carry = split.carry
    }

    return [...lines, ...flushPendingLine(carry, maxLineLength)]
}

function carryAfterChunks(chunks: readonly string[], maxLineLength: number): LineCarry {
    let carry = EMPTY_LINE_CARRY
    for (const chunk of chunks) carry = splitCompleteLines(carry, chunk, maxLineLength).carry
    return carry
}

test('a chunk with no break yields no lines and the whole chunk as carry', () => {
    const split = splitCompleteLines(EMPTY_LINE_CARRY, 'npm install', GENEROUS_LINE_LENGTH)

    assert.deepEqual(split.lines, [])
    assert.deepEqual(split.carry, { pending: 'npm install', isTruncated: false })
})

test('an empty chunk leaves the carry untouched', () => {
    const carry = carryAfterChunks(['half a li'], GENEROUS_LINE_LENGTH)
    const split = splitCompleteLines(carry, '', GENEROUS_LINE_LENGTH)

    assert.deepEqual(split.lines, [])
    assert.deepEqual(split.carry, carry)
})

test('a line split mid-word across two chunks arrives once', () => {
    assert.deepEqual(linesFromChunks(['build succ', 'eeded\n'], GENEROUS_LINE_LENGTH), ['build succeeded'])
})

test('CRLF is one break and leaves no trailing carriage return', () => {
    assert.deepEqual(linesFromChunks(['first\r\nsecond\r\n'], GENEROUS_LINE_LENGTH), ['first', 'second'])
})

test('CRLF split across a chunk boundary stays one break', () => {
    assert.deepEqual(linesFromChunks(['first\r', '\nsecond\r', '\n'], GENEROUS_LINE_LENGTH), ['first', 'second'])
})

test('a lone carriage return is a break', () => {
    assert.deepEqual(linesFromChunks(['[  ] 10%\r[= ] 50%\r[==] 100%\n'], GENEROUS_LINE_LENGTH), [
        '[  ] 10%',
        '[= ] 50%',
        '[==] 100%',
    ])
})

test('a carriage return ending a chunk breaks once the next chunk denies a newline', () => {
    assert.deepEqual(linesFromChunks(['[= ] 50%\r', '[==] 100%\n'], GENEROUS_LINE_LENGTH), ['[= ] 50%', '[==] 100%'])
})

test('a trailing break does not produce an empty final line', () => {
    assert.deepEqual(linesFromChunks(['only\n'], GENEROUS_LINE_LENGTH), ['only'])
    assert.deepEqual(linesFromChunks(['only\r\n'], GENEROUS_LINE_LENGTH), ['only'])
    assert.deepEqual(linesFromChunks(['only\r'], GENEROUS_LINE_LENGTH), ['only'])
})

test('a blank line between two breaks is kept', () => {
    assert.deepEqual(linesFromChunks(['first\n\nthird\n'], GENEROUS_LINE_LENGTH), ['first', '', 'third'])
})

test('a line over the cap is emitted truncated and its remainder is discarded', () => {
    const lines = linesFromChunks(['aaaaaaaaaaaaXXXX\nshort\n'], 8)

    assert.deepEqual(lines, ['aaaaaaaa …[line truncated]', 'short'])
})

test('the remainder of a truncated line is discarded across chunks too', () => {
    const lines = linesFromChunks(['aaaaaaaaaa', 'XXXXXXXXXX', 'XX\nshort\n'], 8)

    assert.deepEqual(lines, ['aaaaaaaa …[line truncated]', 'short'])
})

test('a line of exactly the cap is emitted whole, with no marker', () => {
    assert.deepEqual(linesFromChunks(['aaaaaaaa\n'], 8), ['aaaaaaaa'])
})

test('the truncated carry clears at the break', () => {
    const truncated = carryAfterChunks(['aaaaaaaaaaaa'], 8)
    assert.deepEqual(truncated, { pending: 'aaaaaaaa', isTruncated: true })

    assert.deepEqual(carryAfterChunks(['aaaaaaaaaaaa', '\nbb'], 8), { pending: 'bb', isTruncated: false })
})

test('flushPendingLine emits an unterminated tail and nothing for an empty carry', () => {
    const tail = carryAfterChunks(['done\nno newline here'], GENEROUS_LINE_LENGTH)

    assert.deepEqual(flushPendingLine(tail, GENEROUS_LINE_LENGTH), ['no newline here'])
    assert.deepEqual(flushPendingLine(EMPTY_LINE_CARRY, GENEROUS_LINE_LENGTH), [])
})

test('flushPendingLine marks a tail that was truncated', () => {
    const tail = carryAfterChunks(['aaaaaaaaaaaa'], 8)

    assert.deepEqual(flushPendingLine(tail, 8), ['aaaaaaaa …[line truncated]'])
})

test('the carry never holds more than the cap, so a huge line is never buffered whole', () => {
    assert.deepEqual(carryAfterChunks(['a'.repeat(100000)], 8), { pending: 'aaaaaaaa', isTruncated: true })
})

test('a carry longer than the cap is emitted capped and marked', () => {
    const overlong: LineCarry = { pending: 'a'.repeat(20), isTruncated: false }

    assert.deepEqual(flushPendingLine(overlong, 8), ['aaaaaaaa …[line truncated]'])
    assert.deepEqual(splitCompleteLines(overlong, '\nshort\n', 8).lines, ['aaaaaaaa …[line truncated]', 'short'])
})

test('splitCompleteLines mutates neither the carry it is given nor the one it returns', () => {
    const before = carryAfterChunks(['partial'], GENEROUS_LINE_LENGTH)
    const split = splitCompleteLines(before, ' more\n', GENEROUS_LINE_LENGTH)

    assert.deepEqual(before, { pending: 'partial', isTruncated: false })
    assert.deepEqual(split.lines, ['partial more'])
    assert.deepEqual(split.carry, EMPTY_LINE_CARRY)
})

test('a multi-chunk stream of mixed breaks reassembles in order', () => {
    const lines = linesFromChunks(
        ['> vite build\r\n', 'transforming...\rtransf', 'orming 12 modules\r\n', 'built in 1.2s'],
        GENEROUS_LINE_LENGTH,
    )

    assert.deepEqual(lines, ['> vite build', 'transforming...', 'transforming 12 modules', 'built in 1.2s'])
})
