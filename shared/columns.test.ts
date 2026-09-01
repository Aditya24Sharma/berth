import test from 'node:test'
import assert from 'node:assert/strict'
import { integerColumn, optionalColumn, requiredColumn } from '#shared/columns.ts'
import type { Parsed } from '#shared/json.ts'

function errorFrom<T>(result: Parsed<T>): string {
    if (result.ok) assert.fail(`expected an invalid result, got ${JSON.stringify(result.value)}`)
    return result.error
}

function valueFrom<T>(result: Parsed<T>): T {
    if (!result.ok) assert.fail(`expected a valid result, got ${result.error}`)
    return result.value
}

test('requiredColumn accepts a string', () => {
    assert.equal(valueFrom(requiredColumn('dist', 'output_dir')), 'dist')
})

test('requiredColumn reports a missing column apart from a wrongly typed one', () => {
    assert.equal(errorFrom(requiredColumn(undefined, 'output_dir')), 'missing column output_dir')
    assert.equal(errorFrom(requiredColumn(7, 'output_dir')), 'column output_dir is not a string')
    assert.equal(errorFrom(requiredColumn(null, 'output_dir')), 'column output_dir is not a string')
})

test('optionalColumn reads NULL as null', () => {
    assert.equal(valueFrom(optionalColumn(null, 'commit_sha')), null)
})

test('optionalColumn keeps the rules requiredColumn applies', () => {
    assert.equal(valueFrom(optionalColumn('abc123', 'commit_sha')), 'abc123')
    assert.equal(errorFrom(optionalColumn(7, 'commit_sha')), 'column commit_sha is not a string')
    assert.equal(errorFrom(optionalColumn(undefined, 'commit_sha')), 'missing column commit_sha')
})

test('integerColumn accepts an integer number and an in-range bigint', () => {
    assert.equal(valueFrom(integerColumn(7, 'seq')), 7)
    assert.equal(valueFrom(integerColumn(7n, 'seq')), 7)
    assert.equal(valueFrom(integerColumn(-7n, 'seq')), -7)
})

test('integerColumn rejects a fraction, a string and a missing column', () => {
    assert.equal(errorFrom(integerColumn(7.5, 'seq')), 'column seq is not an integer')
    assert.equal(errorFrom(integerColumn('7', 'seq')), 'column seq is not an integer')
    assert.equal(errorFrom(integerColumn(null, 'seq')), 'column seq is not an integer')
    assert.equal(errorFrom(integerColumn(undefined, 'seq')), 'missing column seq')
})

test('integerColumn rejects a bigint too large to hold instead of rounding it', () => {
    assert.equal(errorFrom(integerColumn(2n ** 70n, 'seq')), 'column seq is outside the safe integer range')
})

test('integerColumn takes the safe range up to its last exact value', () => {
    const highest = BigInt(Number.MAX_SAFE_INTEGER)
    const lowest = BigInt(Number.MIN_SAFE_INTEGER)

    assert.equal(valueFrom(integerColumn(highest, 'seq')), Number.MAX_SAFE_INTEGER)
    assert.equal(valueFrom(integerColumn(lowest, 'seq')), Number.MIN_SAFE_INTEGER)
    assert.equal(errorFrom(integerColumn(highest + 1n, 'seq')), 'column seq is outside the safe integer range')
    assert.equal(errorFrom(integerColumn(lowest - 1n, 'seq')), 'column seq is outside the safe integer range')
})
