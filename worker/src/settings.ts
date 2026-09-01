import type { RetentionPolicy } from '#shared/deployments.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'

export type Environment = Readonly<Record<string, string | undefined>>

export type BuildNetwork = 'bridge' | 'none'

export type BuildLimits = {
    readonly image: string
    readonly memoryMb: number
    readonly cpus: number
    readonly pidsLimit: number
    readonly tmpfsMb: number
    readonly timeoutMs: number
    readonly network: BuildNetwork
}

export type WorkerSettings = {
    readonly limits: BuildLimits
    readonly cloneTimeoutMs: number
    readonly pollIntervalMs: number
    readonly concurrency: number
    readonly collectIntervalMs: number
    readonly retention: RetentionPolicy
}

const DIGITS = /^[0-9]+$/
const DIGITS_WITH_OPTIONAL_FRACTION = /^[0-9]+(\.[0-9]+)?$/

function nonEmptyString(environment: Environment, name: string, fallback: string): Parsed<string> {
    const raw = environment[name]
    if (raw === undefined) return valid(fallback)
    if (raw.length === 0) return invalid(`${name} must not be empty`)
    return valid(raw)
}

function positiveInteger(environment: Environment, name: string, fallback: number): Parsed<number> {
    const raw = environment[name]
    if (raw === undefined) return valid(fallback)
    const value = Number(raw)
    if (!DIGITS.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
        return invalid(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
    }
    return valid(value)
}

function positiveNumber(environment: Environment, name: string, fallback: number): Parsed<number> {
    const raw = environment[name]
    if (raw === undefined) return valid(fallback)
    const value = Number(raw)
    if (!DIGITS_WITH_OPTIONAL_FRACTION.test(raw) || !Number.isFinite(value) || value <= 0) {
        return invalid(`${name} must be a positive number, got ${JSON.stringify(raw)}`)
    }
    return valid(value)
}

function buildNetwork(environment: Environment, name: string, fallback: BuildNetwork): Parsed<BuildNetwork> {
    const raw = environment[name]
    if (raw === undefined) return valid(fallback)
    if (raw !== 'bridge' && raw !== 'none') {
        return invalid(`${name} must be bridge or none, got ${JSON.stringify(raw)}`)
    }
    return valid(raw)
}

export function parseWorkerSettings(environment: Environment): Parsed<WorkerSettings> {
    const image = nonEmptyString(environment, 'BERTH_BUILD_IMAGE', 'node:22-alpine')
    if (!image.ok) return image

    const memoryMb = positiveInteger(environment, 'BERTH_BUILD_MEMORY_MB', 2048)
    if (!memoryMb.ok) return memoryMb

    const cpus = positiveNumber(environment, 'BERTH_BUILD_CPUS', 2)
    if (!cpus.ok) return cpus

    const pidsLimit = positiveInteger(environment, 'BERTH_BUILD_PIDS', 512)
    if (!pidsLimit.ok) return pidsLimit

    const tmpfsMb = positiveInteger(environment, 'BERTH_BUILD_TMPFS_MB', 1024)
    if (!tmpfsMb.ok) return tmpfsMb

    const timeoutMs = positiveInteger(environment, 'BERTH_BUILD_TIMEOUT_MS', 600000)
    if (!timeoutMs.ok) return timeoutMs

    const network = buildNetwork(environment, 'BERTH_BUILD_NETWORK', 'bridge')
    if (!network.ok) return network

    const cloneTimeoutMs = positiveInteger(environment, 'BERTH_CLONE_TIMEOUT_MS', 120000)
    if (!cloneTimeoutMs.ok) return cloneTimeoutMs

    const pollIntervalMs = positiveInteger(environment, 'BERTH_POLL_INTERVAL_MS', 2000)
    if (!pollIntervalMs.ok) return pollIntervalMs

    const concurrency = positiveInteger(environment, 'BERTH_BUILD_CONCURRENCY', 1)
    if (!concurrency.ok) return concurrency

    const collectIntervalMs = positiveInteger(environment, 'BERTH_COLLECT_INTERVAL_MS', 900000)
    if (!collectIntervalMs.ok) return collectIntervalMs

    const keepPerProject = positiveInteger(environment, 'BERTH_KEEP_PER_PROJECT', 10)
    if (!keepPerProject.ok) return keepPerProject

    const retentionDays = positiveInteger(environment, 'BERTH_RETENTION_DAYS', 14)
    if (!retentionDays.ok) return retentionDays

    return valid({
        limits: {
            image: image.value,
            memoryMb: memoryMb.value,
            cpus: cpus.value,
            pidsLimit: pidsLimit.value,
            tmpfsMb: tmpfsMb.value,
            timeoutMs: timeoutMs.value,
            network: network.value,
        },
        cloneTimeoutMs: cloneTimeoutMs.value,
        pollIntervalMs: pollIntervalMs.value,
        concurrency: concurrency.value,
        collectIntervalMs: collectIntervalMs.value,
        retention: {
            keepPerProject: keepPerProject.value,
            retentionDays: retentionDays.value,
        },
    })
}
