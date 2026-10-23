import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { JsonValue } from '#shared/json.ts'
import type { PushEvent } from './webhook.ts'
import {
    GITHUB_EVENT_HEADER,
    GITHUB_SIGNATURE_HEADER,
    isPushToDefaultBranch,
    isSignatureValid,
    parsePushEvent,
} from './webhook.ts'

const SECRET = 'a shared secret'
const BODY = Buffer.from('{"ref":"refs/heads/main"}', 'utf8')

const GITHUB_EXAMPLE_SECRET = 'It\'s a Secret to Everybody'
const GITHUB_EXAMPLE_BODY = Buffer.from('Hello, World!', 'utf8')
const GITHUB_EXAMPLE_SIGNATURE =
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'

function signatureFor(secret: string, body: Buffer): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

function hexOf(signature: string): string {
    return signature.slice('sha256='.length)
}

test('header names are the lowercased ones Node delivers', () => {
    assert.equal(GITHUB_SIGNATURE_HEADER, 'x-hub-signature-256')
    assert.equal(GITHUB_EVENT_HEADER, 'x-github-event')
})

test('isSignatureValid reproduces the signature GitHub publishes', () => {
    assert.equal(
        signatureFor(GITHUB_EXAMPLE_SECRET, GITHUB_EXAMPLE_BODY),
        GITHUB_EXAMPLE_SIGNATURE,
    )
    assert.equal(
        isSignatureValid(GITHUB_EXAMPLE_SECRET, GITHUB_EXAMPLE_BODY, GITHUB_EXAMPLE_SIGNATURE),
        true,
    )
})

test('isSignatureValid rejects a single flipped nibble of the published signature', () => {
    const flipped = `sha256=857107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`
    assert.equal(flipped.length, GITHUB_EXAMPLE_SIGNATURE.length)
    assert.equal(isSignatureValid(GITHUB_EXAMPLE_SECRET, GITHUB_EXAMPLE_BODY, flipped), false)
})

test('isSignatureValid accepts a signature made with the same secret and bytes', () => {
    assert.equal(isSignatureValid(SECRET, BODY, signatureFor(SECRET, BODY)), true)
})

test('isSignatureValid rejects a signature made with a different secret', () => {
    assert.equal(isSignatureValid(SECRET, BODY, signatureFor('another secret', BODY)), false)
})

test('isSignatureValid rejects a body tampered with after signing', () => {
    const signature = signatureFor(SECRET, BODY)
    const tampered = Buffer.from('{"ref":"refs/heads/evil"}', 'utf8')
    assert.equal(isSignatureValid(SECRET, tampered, signature), false)
})

test('isSignatureValid rejects a body tampered with by a single byte', () => {
    const signature = signatureFor(SECRET, BODY)
    const tampered = Buffer.from(BODY)
    tampered[0] = BODY[0] === undefined ? 0 : BODY[0] ^ 1
    assert.equal(isSignatureValid(SECRET, tampered, signature), false)
})

test('isSignatureValid rejects an absent header', () => {
    assert.equal(isSignatureValid(SECRET, BODY, undefined), false)
})

test('isSignatureValid rejects a repeated header arriving as an array', () => {
    const signature = signatureFor(SECRET, BODY)
    assert.equal(isSignatureValid(SECRET, BODY, [signature]), false)
    assert.equal(isSignatureValid(SECRET, BODY, [signature, signature]), false)
})

test('isSignatureValid rejects an empty header without throwing', () => {
    assert.equal(isSignatureValid(SECRET, BODY, ''), false)
})

test('isSignatureValid rejects a short signature without throwing', () => {
    const short = `sha256=${hexOf(signatureFor(SECRET, BODY)).slice(0, 63)}`
    assert.equal(short.length, 70)
    assert.equal(isSignatureValid(SECRET, BODY, short), false)
})

test('isSignatureValid rejects a long signature without throwing', () => {
    const long = `${signatureFor(SECRET, BODY)}0`
    assert.equal(long.length, 72)
    assert.equal(isSignatureValid(SECRET, BODY, long), false)
})

test('isSignatureValid rejects a correct-length signature that is not hex', () => {
    const signature = signatureFor(SECRET, BODY)
    const notHex = `${signature.slice(0, -1)}z`
    assert.equal(notHex.length, signature.length)
    assert.equal(isSignatureValid(SECRET, BODY, notHex), false)
})

test('isSignatureValid rejects the right digest in uppercase hex', () => {
    const upper = `sha256=${hexOf(signatureFor(SECRET, BODY)).toUpperCase()}`
    assert.equal(upper.length, 71)
    assert.equal(isSignatureValid(SECRET, BODY, upper), false)
})

test('isSignatureValid rejects the right digest without the sha256= prefix', () => {
    assert.equal(isSignatureValid(SECRET, BODY, hexOf(signatureFor(SECRET, BODY))), false)
})

test('isSignatureValid rejects the sha1 header value GitHub also sends', () => {
    const sha1 = `sha1=${createHmac('sha1', SECRET).update(BODY).digest('hex')}`
    assert.equal(isSignatureValid(SECRET, BODY, sha1), false)
})

test('isSignatureValid signs an empty body rather than refusing it', () => {
    const empty = Buffer.alloc(0)
    assert.equal(isSignatureValid(SECRET, empty, signatureFor(SECRET, empty)), true)
    assert.equal(isSignatureValid(SECRET, empty, signatureFor(SECRET, BODY)), false)
})

test('isSignatureValid rejects everything when no secret is configured', () => {
    const empty = ''
    assert.equal(isSignatureValid(empty, BODY, signatureFor(empty, BODY)), false)
    assert.equal(isSignatureValid(empty, BODY, undefined), false)
})

test('isSignatureValid covers the raw bytes, not the re-serialised json', () => {
    const raw = Buffer.from('{"b":1,  "a":"\\u00e9"}', 'utf8')
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8')
    assert.notEqual(raw.toString('utf8'), reserialised.toString('utf8'))

    assert.equal(isSignatureValid(SECRET, raw, signatureFor(SECRET, raw)), true)
    assert.equal(isSignatureValid(SECRET, raw, signatureFor(SECRET, reserialised)), false)
})

const HEAD_SHA = '9d3c1e0b7a5f4826d0c1b9e73a2f5081cc46ab7e'
const ZERO_SHA = '0'.repeat(40)

function pushPayload(overrides: Record<string, JsonValue>): Record<string, JsonValue> {
    return {
        ref: 'refs/heads/main',
        after: HEAD_SHA,
        deleted: false,
        repository: { default_branch: 'main' },
        ...overrides,
    }
}

function parsedPush(body: JsonValue): PushEvent {
    const result = parsePushEvent(body)
    assert.ok(result.ok, result.ok ? '' : result.error)
    return result.value
}

test('parsePushEvent reads the ref, default branch and commit to build', () => {
    assert.deepEqual(parsedPush(pushPayload({})), {
        ref: 'refs/heads/main',
        defaultBranch: 'main',
        commitSha: HEAD_SHA,
        isBranchDeletion: false,
    })
})

test('parsePushEvent reports a deletion flagged by GitHub', () => {
    assert.equal(parsedPush(pushPayload({ deleted: true })).isBranchDeletion, true)
})

test('parsePushEvent reports a deletion spelled as forty zeroes', () => {
    const event = parsedPush(pushPayload({ after: ZERO_SHA, ref: 'refs/heads/main' }))
    assert.equal(event.isBranchDeletion, true)
    assert.equal(event.commitSha, ZERO_SHA)
})

test('parsePushEvent treats an absent deleted field as no deletion', () => {
    const { deleted, ...withoutDeleted } = pushPayload({})
    assert.equal(parsedPush(withoutDeleted).isBranchDeletion, false)
})

test('parsePushEvent keeps the branch the push was to', () => {
    assert.equal(parsedPush(pushPayload({ ref: 'refs/heads/feature' })).ref, 'refs/heads/feature')
})

test('parsePushEvent rejects a payload that is not an object', () => {
    assert.equal(parsePushEvent('refs/heads/main').ok, false)
    assert.equal(parsePushEvent(null).ok, false)
    assert.equal(parsePushEvent([pushPayload({})]).ok, false)
})

test('parsePushEvent rejects a ping payload, which carries no push', () => {
    const ping: Record<string, JsonValue> = {
        zen: 'Non-blocking is better than blocking.',
        hook_id: 1,
        repository: { default_branch: 'main' },
    }
    assert.equal(parsePushEvent(ping).ok, false)
})

test('parsePushEvent rejects a missing or unusable field', () => {
    const { ref, ...withoutRef } = pushPayload({})
    assert.equal(parsePushEvent(withoutRef).ok, false)

    const { after, ...withoutAfter } = pushPayload({})
    assert.equal(parsePushEvent(withoutAfter).ok, false)

    assert.equal(parsePushEvent(pushPayload({ ref: 42 })).ok, false)
    assert.equal(parsePushEvent(pushPayload({ deleted: 'true' })).ok, false)
    assert.equal(parsePushEvent(pushPayload({ repository: 'octocat/blog' })).ok, false)
    assert.equal(parsePushEvent(pushPayload({ repository: {} })).ok, false)
    assert.equal(parsePushEvent(pushPayload({ repository: { default_branch: '' } })).ok, false)
})

test('parsePushEvent rejects an after that is not a full commit sha', () => {
    assert.equal(parsePushEvent(pushPayload({ after: HEAD_SHA.slice(0, 7) })).ok, false)
    assert.equal(parsePushEvent(pushPayload({ after: HEAD_SHA.toUpperCase() })).ok, false)
    assert.equal(parsePushEvent(pushPayload({ after: `${HEAD_SHA}0` })).ok, false)
})

test('isPushToDefaultBranch accepts the default branch only', () => {
    assert.equal(isPushToDefaultBranch(parsedPush(pushPayload({}))), true)
    assert.equal(
        isPushToDefaultBranch(parsedPush(pushPayload({ ref: 'refs/heads/feature' }))),
        false,
    )
})

test('isPushToDefaultBranch respects a project whose default branch is not main', () => {
    const payload = pushPayload({ ref: 'refs/heads/trunk', repository: { default_branch: 'trunk' } })
    assert.equal(isPushToDefaultBranch(parsedPush(payload)), true)
    assert.equal(isPushToDefaultBranch(parsedPush(pushPayload({}))), true)
    assert.equal(
        isPushToDefaultBranch(parsedPush(pushPayload({ repository: { default_branch: 'trunk' } }))),
        false,
    )
})

test('isPushToDefaultBranch rejects a tag and a branch that merely starts with the name', () => {
    assert.equal(isPushToDefaultBranch(parsedPush(pushPayload({ ref: 'refs/tags/main' }))), false)
    assert.equal(
        isPushToDefaultBranch(parsedPush(pushPayload({ ref: 'refs/heads/main-backup' }))),
        false,
    )
})
