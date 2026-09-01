export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue }

export type Parsed<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: string }

export function valid<T>(value: T): Parsed<T> {
    return { ok: true, value }
}

export function invalid<T>(error: string): Parsed<T> {
    return { ok: false, error }
}

export function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
