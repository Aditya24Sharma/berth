import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkerSettings, type WorkerSettings } from './settings.ts'

const DEFAULTS: WorkerSettings = {
    limits: {
        image: 'node:22-alpine',
        memoryMb: 2048,
        cpus: 2,
        pidsLimit: 512,
        tmpfsMb: 1024,
        timeoutMs: 600000,
        network: 'bridge',
    },
    cloneTimeoutMs: 120000,
    pollIntervalMs: 2000,
    concurrency: 1,
    collectIntervalMs: 900000,
    retention: {
        keepPerProject: 10,
        retentionDays: 14,
    },
}

const CONSTRAINED_VARIABLES: readonly string[] = [
    'BERTH_BUILD_MEMORY_MB',
    'BERTH_BUILD_CPUS',
    'BERTH_BUILD_PIDS',
    'BERTH_BUILD_TMPFS_MB',
    'BERTH_BUILD_TIMEOUT_MS',
    'BERTH_BUILD_NETWORK',
    'BERTH_CLONE_TIMEOUT_MS',
    'BERTH_POLL_INTERVAL_MS',
    'BERTH_BUILD_CONCURRENCY',
    'BERTH_COLLECT_INTERVAL_MS',
    'BERTH_KEEP_PER_PROJECT',
    'BERTH_RETENTION_DAYS',
]

const REJECTED: readonly (readonly [string, string])[] = [
    ['BERTH_BUILD_TIMEOUT_MS', 'soon'],
    ['BERTH_BUILD_MEMORY_MB', '-1'],
    ['BERTH_BUILD_CONCURRENCY', '0'],
    ['BERTH_BUILD_NETWORK', 'host'],
    ['BERTH_BUILD_IMAGE', ''],
    ['BERTH_BUILD_CPUS', 'many'],
    ['BERTH_BUILD_CPUS', '0'],
    ['BERTH_BUILD_CPUS', '-1.5'],
    ['BERTH_BUILD_PIDS', '1.5'],
    ['BERTH_BUILD_TMPFS_MB', '1e3'],
    ['BERTH_CLONE_TIMEOUT_MS', ' 30000 '],
    ['BERTH_POLL_INTERVAL_MS', '0x10'],
    ['BERTH_COLLECT_INTERVAL_MS', ''],
    ['BERTH_KEEP_PER_PROJECT', 'Infinity'],
    ['BERTH_RETENTION_DAYS', '99999999999999999999'],
]

test('parseWorkerSettings falls back to every default on an empty environment', () => {
    const result = parseWorkerSettings({})
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.deepEqual(result.value, DEFAULTS)
})

test('parseWorkerSettings ignores variables it does not name', () => {
    const result = parseWorkerSettings({ PATH: '/usr/bin', HOME: '/root', BERTH_PROXY_PORT: 'nonsense' })
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.deepEqual(result.value, DEFAULTS)
})

for (const name of CONSTRAINED_VARIABLES) {
    test(`parseWorkerSettings refuses to default ${name} past a nonsense value`, () => {
        const result = parseWorkerSettings({ [name]: 'banana' })
        assert.ok(!result.ok, `${name}='banana' was accepted, so it silently became its default`)
        assert.ok(result.error.startsWith(name), `error should name ${name}, got: ${result.error}`)
    })
}

for (const [name, value] of REJECTED) {
    test(`parseWorkerSettings rejects ${name}=${JSON.stringify(value)}`, () => {
        const result = parseWorkerSettings({ [name]: value })
        assert.ok(!result.ok, `expected ${name}=${JSON.stringify(value)} to be rejected`)
        assert.ok(result.error.startsWith(name), `error should name ${name}, got: ${result.error}`)
    })
}

test('parseWorkerSettings reads every override into its own field', () => {
    const result = parseWorkerSettings({
        BERTH_BUILD_IMAGE: 'node:24-alpine',
        BERTH_BUILD_MEMORY_MB: '4096',
        BERTH_BUILD_CPUS: '1.5',
        BERTH_BUILD_PIDS: '256',
        BERTH_BUILD_TMPFS_MB: '512',
        BERTH_BUILD_TIMEOUT_MS: '60000',
        BERTH_BUILD_NETWORK: 'none',
        BERTH_CLONE_TIMEOUT_MS: '30000',
        BERTH_POLL_INTERVAL_MS: '500',
        BERTH_BUILD_CONCURRENCY: '3',
        BERTH_COLLECT_INTERVAL_MS: '90000',
        BERTH_KEEP_PER_PROJECT: '5',
        BERTH_RETENTION_DAYS: '30',
    })
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.deepEqual(result.value, {
        limits: {
            image: 'node:24-alpine',
            memoryMb: 4096,
            cpus: 1.5,
            pidsLimit: 256,
            tmpfsMb: 512,
            timeoutMs: 60000,
            network: 'none',
        },
        cloneTimeoutMs: 30000,
        pollIntervalMs: 500,
        concurrency: 3,
        collectIntervalMs: 90000,
        retention: {
            keepPerProject: 5,
            retentionDays: 30,
        },
    })
})

test('parseWorkerSettings rejects an invalid variable even when the rest are valid', () => {
    const result = parseWorkerSettings({ BERTH_BUILD_CONCURRENCY: '4', BERTH_BUILD_TIMEOUT_MS: 'soon' })
    assert.ok(!result.ok, 'expected a named error rather than a coerced timeout')
    assert.equal(result.error, 'BERTH_BUILD_TIMEOUT_MS must be a positive integer, got "soon"')
})

test('parseWorkerSettings accepts any non-empty image, since berth does not police registries', () => {
    const result = parseWorkerSettings({ BERTH_BUILD_IMAGE: 'ghcr.io/acme/builder:banana' })
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.equal(result.value.limits.image, 'ghcr.io/acme/builder:banana')
})

test('parseWorkerSettings keeps a whole-number cpus override a number, not a string', () => {
    const result = parseWorkerSettings({ BERTH_BUILD_CPUS: '4' })
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.equal(result.value.limits.cpus, 4)
})
