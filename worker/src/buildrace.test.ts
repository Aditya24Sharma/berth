import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { insertQueuedDeployment, loadDeployment } from '#shared/deployments.ts'
import { newDeploymentId, newProjectId, parseDeploymentId, parseRepoUrl } from '#shared/ids.ts'
import type { DeploymentId, ProjectId } from '#shared/ids.ts'
import { loadLogLinesAfter } from '#shared/logs.ts'
import { databasePath, deploymentDir, deploymentsDir } from '#shared/paths.ts'
import { insertProject } from '#shared/projects.ts'

const WORKERS = 4
const QUEUED = 200
const START_DELAY_MS = 800
const OUTPUT_DIR = 'dist'
const BUILT_BY_FILE = 'built-by'
const LINES_PER_BUILD = 2
const CHILD = join(import.meta.dirname, 'buildrace.child.ts')

type WorkerRun = {
    readonly label: string
    readonly built: readonly DeploymentId[]
}

function runWorkerToQueueEmpty(label: string, startAt: number, dataDir: string): Promise<WorkerRun> {
    return new Promise((resolve, reject) => {
        let out = ''
        let errors = ''
        const child = spawn(process.execPath, [CHILD, String(startAt), label], {
            env: { ...process.env, BERTH_DATA_DIR: dataDir },
        })

        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
            errors += chunk.toString('utf8')
        })
        child.on('error', (cause) => {
            reject(new Error(`worker ${label} could not be started: ${cause.message}`))
        })
        child.on('close', () => {
            const line = out.trim()
            if (!line.startsWith('OK')) {
                reject(new Error(`worker ${label} failed: ${line}\n${errors}`))
                return
            }
            resolve({ label, built: builtIds(line) })
        })
    })
}

function builtIds(line: string): readonly DeploymentId[] {
    const built: DeploymentId[] = []

    for (const field of line.slice(2).split(' ')) {
        if (field.length === 0) continue

        const id = parseDeploymentId(field)
        if (id === null) throw new Error(`a worker printed something that is not a deployment id: ${field}`)
        built.push(id)
    }

    return built
}

function insertOwningProject(db: DatabaseSync): ProjectId {
    const repoUrl = parseRepoUrl('https://example.com/site.git')
    assert.notEqual(repoUrl, null)
    if (repoUrl === null) throw new Error('unreachable')

    const id = newProjectId()
    insertProject(db, id, { name: 'site', repoUrl, buildCmd: 'npm run build', outputDir: OUTPUT_DIR })
    return id
}

function insertQueue(db: DatabaseSync, projectId: ProjectId, count: number): ReadonlySet<DeploymentId> {
    const queued = new Set<DeploymentId>()

    db.exec('BEGIN IMMEDIATE')
    for (let n = 0; n < count; n++) {
        const id = newDeploymentId()
        insertQueuedDeployment(db, id, projectId)
        queued.add(id)
    }
    db.exec('COMMIT')

    return queued
}

function assertTheQueueWasContested(runs: readonly WorkerRun[]): void {
    const contenders = runs.filter((run) => run.built.length > 0).length

    assert.ok(
        contenders >= 2,
        `${contenders} of ${WORKERS} workers claimed anything, so nothing here raced and the run proves nothing`,
    )
}

function assertEveryDeploymentIsReady(db: DatabaseSync, queued: ReadonlySet<DeploymentId>): void {
    for (const id of queued) {
        const deployment = loadDeployment(db, id)
        if (deployment === null) assert.fail(`${id} is gone from the database`)
        if (!deployment.ok) assert.fail(`${id} did not parse: ${deployment.error}`)

        const ended = deployment.value
        assert.equal(ended.status, 'ready', `${id} ended ${ended.status}: ${ended.status === 'failed' ? ended.error : ''}`)
    }
}

function assertOneDirectoryPerDeploymentWrittenByItsClaimant(builtBy: ReadonlyMap<DeploymentId, string>): void {
    assert.deepEqual(readdirSync(deploymentsDir()).sort(), [...builtBy.keys()].sort())

    for (const [id, label] of builtBy) {
        assert.deepEqual(readdirSync(deploymentDir(id)), [BUILT_BY_FILE], `${id} holds more than one build's output`)
        assert.equal(readFileSync(join(deploymentDir(id), BUILT_BY_FILE), 'utf8'), label)
    }
}

function assertOneWorkersLogLines(db: DatabaseSync, builtBy: ReadonlyMap<DeploymentId, string>): void {
    for (const [id, label] of builtBy) {
        const logs = loadLogLinesAfter(db, id, 0, LINES_PER_BUILD * WORKERS)
        if (!logs.ok) assert.fail(`the logs of ${id} did not parse: ${logs.error}`)

        assert.deepEqual(
            logs.value.map((line) => line.seq),
            [1, 2],
            `${id} has ${logs.value.length} log lines, not one build's worth`,
        )
        for (const { line } of logs.value) assert.ok(line.startsWith(label), `${id} logged a line from ${line}`)
    }
}

test('concurrent workers build every queued deployment exactly once', async () => {
    const previousDataDir = process.env.BERTH_DATA_DIR
    const dataDir = mkdtempSync(join(tmpdir(), 'berth-buildrace-'))
    process.env.BERTH_DATA_DIR = dataDir

    try {
        const seeding = openDatabase(databasePath())
        const queued = insertQueue(seeding, insertOwningProject(seeding), QUEUED)
        seeding.close()
        assert.equal(queued.size, QUEUED)

        const startAt = Date.now() + START_DELAY_MS
        const labels = Array.from({ length: WORKERS }, (_, n) => `worker-${n}`)
        const runs = await Promise.all(labels.map((label) => runWorkerToQueueEmpty(label, startAt, dataDir)))

        assertTheQueueWasContested(runs)

        const claimed = runs.flatMap((run) => [...run.built])
        assert.equal(claimed.length, QUEUED, `${WORKERS} workers claimed ${claimed.length} times for ${QUEUED} queued`)
        assert.equal(new Set(claimed).size, claimed.length, 'a deployment was claimed by more than one worker')
        assert.deepEqual([...claimed].sort(), [...queued].sort())

        const builtBy = new Map<DeploymentId, string>()
        for (const run of runs) for (const id of run.built) builtBy.set(id, run.label)

        const db = openDatabase(databasePath())
        try {
            assertEveryDeploymentIsReady(db, queued)
            assertOneDirectoryPerDeploymentWrittenByItsClaimant(builtBy)
            assertOneWorkersLogLines(db, builtBy)
        } finally {
            db.close()
        }
    } finally {
        rmSync(dataDir, { recursive: true, force: true })
        if (previousDataDir === undefined) delete process.env.BERTH_DATA_DIR
        else process.env.BERTH_DATA_DIR = previousDataDir
    }
})
