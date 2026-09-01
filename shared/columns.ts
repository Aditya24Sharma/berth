import type { SQLOutputValue } from 'node:sqlite'
import { invalid, valid, type Parsed } from '#shared/json.ts'

const SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER)
const SAFE_INTEGER_MIN = BigInt(Number.MIN_SAFE_INTEGER)

export function requiredColumn(value: SQLOutputValue | undefined, name: string): Parsed<string> {
    if (value === undefined) return invalid(`missing column ${name}`)
    if (typeof value !== 'string') return invalid(`column ${name} is not a string`)
    return valid(value)
}

export function optionalColumn(value: SQLOutputValue | undefined, name: string): Parsed<string | null> {
    if (value === null) return valid(null)
    return requiredColumn(value, name)
}

export function integerColumn(value: SQLOutputValue | undefined, name: string): Parsed<number> {
    if (value === undefined) return invalid(`missing column ${name}`)
    if (typeof value === 'number') {
        if (!Number.isInteger(value)) return invalid(`column ${name} is not an integer`)
        return valid(value)
    }
    if (typeof value !== 'bigint') return invalid(`column ${name} is not an integer`)
    if (value > SAFE_INTEGER_MAX || value < SAFE_INTEGER_MIN) {
        return invalid(`column ${name} is outside the safe integer range`)
    }
    return valid(Number(value))
}
