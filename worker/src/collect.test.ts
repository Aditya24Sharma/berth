import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { loadDeployment } from '#shared/deployments.ts'
import type { RetentionPolicy } from '#shared/deployments.ts'
import { newDeploymentId, newProjectId } from '#shared/ids.ts'
import type { DeploymentId, ProjectId } from '#shared/ids.ts'
import { databasePath, deploymentDir, deploymentsDir, trashDir, trashedDeploymentDir } from '#shared/paths.ts'
import { collectUnreferencedDeployments } from './collect.ts'
import type { CollectionReport } from './collect.ts'

const ORPHAN_MINIMUM_AGE_MS = 60_000
const POLICY: RetentionPolicy = { keepPerProject: 2, retentionDays: 1 }

const ANCIENT = [
    '2020-01-01T00:00:00Z',
    '2020-02-01T00:00:00Z',
    '2020-03-01T00:00:00Z',
    '2020-04-01T00:00:00Z',
] as const

function withStore(body: (db: DatabaseSync) => void): void {
    const dataDir = mkdtempSync(join(tmpdir(), 'berth-collect-'))
    process.env.BERTH_DATA_DIR = dataDir
    try {
        const db = openDatabase(databasePath())
        try {
            body(db)
        } finally {
            db.close()
        }
    } finally {
        rmSync(dataDir, { recursive: true, force: true })
    }
}

function insertProject(db: DatabaseSync): ProjectId {
    const id = newProjectId()
    db.prepare(
        `INSERT INTO projects (id, name, repo_url, build_cmd, output_dir)
         VALUES (?, 'site', 'https://example.com/site.git', 'npm run build', 'dist')`,
    ).run(id)
    return id
}

function insertReadyDeployment(db: DatabaseSync, projectId: ProjectId, at: string): DeploymentId {
    const id = newDeploymentId()
    db.prepare(
        `INSERT INTO deployments (id, project_id, status, created_at, started_at, finished_at)
         VALUES (?, ?, 'ready', ?, ?, ?)`,
    ).run(id, projectId, at, at, at)
    return id
}

function pointAlias(db: DatabaseSync, hostname: string, id: DeploymentId): void {
    db.prepare('INSERT INTO aliases (hostname, deployment_id) VALUES (?, ?)').run(hostname, id)
}

function writeDeploymentDirectory(id: DeploymentId, modifiedAgoMs = 0): string {
    const directory = deploymentDir(id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'index.html'), `<h1>${id}</h1>`)

    const modifiedAt = new Date(Date.now() - modifiedAgoMs)
    utimesSync(directory, modifiedAt, modifiedAt)
    return directory
}

function collect(db: DatabaseSync): CollectionReport {
    return collectUnreferencedDeployments(db, POLICY, ORPHAN_MINIMUM_AGE_MS)
}

function isServed(id: DeploymentId): boolean {
    return existsSync(join(deploymentDir(id), 'index.html'))
}

test('a collected deployment loses its row and its files, and the trash is left empty', () => {
    withStore((db) => {
        const projectId = insertProject(db)
        const oldest = insertReadyDeployment(db, projectId, ANCIENT[0])
        const middle = insertReadyDeployment(db, projectId, ANCIENT[1])
        const newest = insertReadyDeployment(db, projectId, ANCIENT[2])
        for (const id of [oldest, middle, newest]) writeDeploymentDirectory(id)

        const report = collect(db)

        assert.deepEqual(report.collectedDeployments, [oldest])
        assert.deepEqual(report.failures, [])
        assert.equal(loadDeployment(db, oldest), null)
        assert.equal(existsSync(deploymentDir(oldest)), false)
        assert.equal(existsSync(trashDir()), false)
    })
})

test('a kept deployment keeps every byte the collector walked past', () => {
    withStore((db) => {
        const projectId = insertProject(db)
        const oldest = insertReadyDeployment(db, projectId, ANCIENT[0])
        const middle = insertReadyDeployment(db, projectId, ANCIENT[1])
        const newest = insertReadyDeployment(db, projectId, ANCIENT[2])
        for (const id of [oldest, middle, newest]) writeDeploymentDirectory(id)

        collect(db)

        for (const id of [middle, newest]) {
            assert.notEqual(loadDeployment(db, id), null)
            assert.equal(readFileSync(join(deploymentDir(id), 'index.html'), 'utf8'), `<h1>${id}</h1>`)
        }
    })
})

test('the deployment an alias points at keeps its row and its files', () => {
    withStore((db) => {
        const projectId = insertProject(db)
        const aliased = insertReadyDeployment(db, projectId, ANCIENT[0])
        const unaliased = insertReadyDeployment(db, projectId, ANCIENT[1])
        insertReadyDeployment(db, projectId, ANCIENT[2])
        insertReadyDeployment(db, projectId, ANCIENT[3])
        writeDeploymentDirectory(aliased)
        writeDeploymentDirectory(unaliased)
        pointAlias(db, 'live.localhost', aliased)

        const report = collect(db)

        assert.deepEqual(report.collectedDeployments, [unaliased])
        assert.notEqual(loadDeployment(db, aliased), null)
        assert.equal(isServed(aliased), true)
        assert.equal(isServed(unaliased), false)
    })
})

test('a collected deployment whose directory has already gone is not a failure', () => {
    withStore((db) => {
        const projectId = insertProject(db)
        const oldest = insertReadyDeployment(db, projectId, ANCIENT[0])
        insertReadyDeployment(db, projectId, ANCIENT[1])
        insertReadyDeployment(db, projectId, ANCIENT[2])

        const report = collect(db)

        assert.deepEqual(report.collectedDeployments, [oldest])
        assert.deepEqual(report.failures, [])
        assert.equal(loadDeployment(db, oldest), null)
    })
})

test('a directory that cannot leave the store is reported rather than swallowed', () => {
    withStore((db) => {
        const projectId = insertProject(db)
        const oldest = insertReadyDeployment(db, projectId, ANCIENT[0])
        insertReadyDeployment(db, projectId, ANCIENT[1])
        insertReadyDeployment(db, projectId, ANCIENT[2])
        writeDeploymentDirectory(oldest)
        mkdirSync(trashedDeploymentDir(oldest), { recursive: true })
        writeFileSync(join(trashedDeploymentDir(oldest), 'in-the-way'), 'a trash entry a previous run left')

        const report = collect(db)

        assert.deepEqual(
            report.failures.map((failure) => failure.kind),
            ['directoryNotRemoved'],
        )
        assert.equal(isServed(oldest), true)
        assert.equal(existsSync(trashDir()), false)
    })
})

test('a directory nothing has a row for is collected once it is older than the orphan age', () => {
    withStore((db) => {
        insertProject(db)
        const orphan = newDeploymentId()
        writeDeploymentDirectory(orphan, 10 * ORPHAN_MINIMUM_AGE_MS)

        const report = collect(db)

        assert.deepEqual(report.collectedOrphanDirectories, [orphan])
        assert.equal(existsSync(deploymentDir(orphan)), false)
        assert.equal(existsSync(trashDir()), false)
    })
})

test('a directory a build may still be renaming into place is left alone', () => {
    withStore((db) => {
        insertProject(db)
        const arriving = newDeploymentId()
        writeDeploymentDirectory(arriving)

        const report = collect(db)

        assert.deepEqual(report.collectedOrphanDirectories, [])
        assert.equal(isServed(arriving), true)
    })
})

test('an old directory whose deployment is still building is not an orphan', () => {
    withStore((db) => {
        const projectId = insertProject(db)
        const id = newDeploymentId()
        db.prepare(
            `INSERT INTO deployments (id, project_id, status, created_at, started_at)
             VALUES (?, ?, 'building', ?, ?)`,
        ).run(id, projectId, ANCIENT[0], ANCIENT[0])
        writeDeploymentDirectory(id, 10 * ORPHAN_MINIMUM_AGE_MS)

        const report = collect(db)

        assert.deepEqual(report.collectedOrphanDirectories, [])
        assert.equal(isServed(id), true)
    })
})

test('a name that is not a deployment id is reported and never touched', () => {
    withStore((db) => {
        insertProject(db)
        const store = deploymentsDir()
        mkdirSync(join(store, 'tmp'), { recursive: true })
        writeFileSync(join(store, 'notes.txt'), 'not a deployment')
        const stranger = new Date(Date.now() - 10 * ORPHAN_MINIMUM_AGE_MS)
        utimesSync(join(store, 'tmp'), stranger, stranger)
        utimesSync(join(store, 'notes.txt'), stranger, stranger)

        const report = collect(db)

        assert.deepEqual([...report.skippedNames].sort(), ['notes.txt', 'tmp'])
        assert.deepEqual(report.collectedOrphanDirectories, [])
        assert.equal(existsSync(join(store, 'tmp')), true)
        assert.equal(readFileSync(join(store, 'notes.txt'), 'utf8'), 'not a deployment')
    })
})

test('a second sweep over the same store changes nothing', () => {
    withStore((db) => {
        const projectId = insertProject(db)
        const oldest = insertReadyDeployment(db, projectId, ANCIENT[0])
        const middle = insertReadyDeployment(db, projectId, ANCIENT[1])
        const newest = insertReadyDeployment(db, projectId, ANCIENT[2])
        for (const id of [oldest, middle, newest]) writeDeploymentDirectory(id)
        const orphan = newDeploymentId()
        writeDeploymentDirectory(orphan, 10 * ORPHAN_MINIMUM_AGE_MS)
        collect(db)

        const report = collect(db)

        assert.deepEqual(report, {
            collectedDeployments: [],
            collectedOrphanDirectories: [],
            skippedNames: [],
            failures: [],
        })
        assert.equal(isServed(middle), true)
        assert.equal(isServed(newest), true)
    })
})
