import { createHmac, timingSafeEqual } from 'node:crypto'
import type { CommitSha } from '#shared/ids.ts'
import type { JsonValue, Parsed } from '#shared/json.ts'
import { parseCommitSha } from '#shared/ids.ts'
import { invalid, isJsonObject, requiredString, valid } from '#shared/json.ts'

export const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256'
export const GITHUB_EVENT_HEADER = 'x-github-event'

const BRANCH_DELETION_SHA = '0'.repeat(40)

export type PushEvent = {
    readonly ref: string
    readonly defaultBranch: string
    readonly commitSha: CommitSha
    readonly isBranchDeletion: boolean
}

// The digest covers the bytes GitHub signed. Re-serialising the parsed JSON changes key
// order, whitespace and unicode escaping, and the digest then never matches.
export function isSignatureValid(
    secret: string,
    body: Buffer,
    signatureHeader: string | readonly string[] | undefined,
): boolean {
    if (secret.length === 0) return false
    if (typeof signatureHeader !== 'string') return false

    const expected = Buffer.from(
        `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
        'utf8',
    )
    const received = Buffer.from(signatureHeader, 'utf8')

    // timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on unequal lengths, so
    // without this guard every malformed header is a crash and a length oracle. The
    // length it compares is the fixed 71 characters GitHub already documents.
    if (expected.length !== received.length) return false

    return timingSafeEqual(expected, received)
}

export function parsePushEvent(body: JsonValue): Parsed<PushEvent> {
    if (!isJsonObject(body)) {
        const got = Array.isArray(body) ? 'array' : typeof body
        return invalid(`expected an object, got ${got}`)
    }

    const ref = requiredString(body['ref'], 'ref')
    if (!ref.ok) return ref

    const after = requiredString(body['after'], 'after')
    if (!after.ok) return after

    const commitSha = parseCommitSha(after.value)
    if (commitSha === null) return invalid('after is not a full commit sha')

    const repository = body['repository']
    if (repository === undefined || !isJsonObject(repository)) {
        return invalid('repository must be an object')
    }

    const defaultBranch = requiredString(repository['default_branch'], 'repository.default_branch')
    if (!defaultBranch.ok) return defaultBranch

    const deleted = body['deleted']
    if (deleted !== undefined && typeof deleted !== 'boolean') {
        return invalid('deleted must be a boolean')
    }

    return valid({
        ref: ref.value,
        defaultBranch: defaultBranch.value,
        commitSha,
        isBranchDeletion: deleted === true || after.value === BRANCH_DELETION_SHA,
    })
}

export function isPushToDefaultBranch(event: PushEvent): boolean {
    return event.ref === `refs/heads/${event.defaultBranch}`
}
