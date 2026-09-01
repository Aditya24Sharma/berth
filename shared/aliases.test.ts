import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { newDeploymentId, newProjectId } from '#shared/ids.ts'
import type { DeploymentId, Hostname, ProjectId } from '#shared/ids.ts'
import type { Parsed } from '#shared/json.ts'
import { loadDeployment } from '#shared/deployments.ts'
import type { ReadyDeployment } from '#shared/deployments.ts'
import {
    deleteAlias,
    loadAlias,
    loadAliases,
    loadAliasesForDeployment,
    parseAliasHostname,
    parseAliasRow,
    parsePointAliasBody,
    pointAliasAt,
} from '#shared/aliases.ts'
import type { Alias } from '#shared/aliases.ts'

function valueFrom<T>(result: Parsed<T>): T {
    if (!result.ok) assert.fail(`expected a valid result, got ${result.error}`)
    return result.value
}

function errorFrom<T>(result: Parsed<T>): string {
    if (result.ok) assert.fail(`expected an invalid result, got ${JSON.stringify(result.value)}`)
    return result.error
}

function hostname(value: string): Hostname {
    return valueFrom(parseAliasHostname(value))
}

function insertProject(db: DatabaseSync): ProjectId {
    const id = newProjectId()
    db.prepare(
        `INSERT INTO projects (id, name, repo_url, build_cmd, output_dir)
         VALUES (?, ?, 'https://example.invalid/site.git', 'npm run build', 'dist')`,
    ).run(id, id)
    return id
}

function insertQueued(db: DatabaseSync, projectId: ProjectId): DeploymentId {
    const id = newDeploymentId()
    db.prepare('INSERT INTO deployments (id, project_id) VALUES (?, ?)').run(id, projectId)
    return id
}

function insertBuilding(db: DatabaseSync, projectId: ProjectId): DeploymentId {
    const id = newDeploymentId()
    db.prepare(
        `INSERT INTO deployments (id, project_id, status, started_at)
         VALUES (?, ?, 'building', '2026-01-01T00:00:00Z')`,
    ).run(id, projectId)
    return id
}

function insertFailed(db: DatabaseSync, projectId: ProjectId): DeploymentId {
    const id = newDeploymentId()
    db.prepare(
        `INSERT INTO deployments (id, project_id, status, started_at, finished_at, error)
         VALUES (?, ?, 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 'the build exploded')`,
    ).run(id, projectId)
    return id
}

function insertReady(db: DatabaseSync, projectId: ProjectId): ReadyDeployment {
    const id = newDeploymentId()
    db.prepare(
        `INSERT INTO deployments (id, project_id, status, started_at, finished_at)
         VALUES (?, ?, 'ready', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')`,
    ).run(id, projectId)

    const stored = loadDeployment(db, id)
    if (stored === null) assert.fail(`no deployment ${id}`)
    const deployment = valueFrom(stored)
    if (deployment.status !== 'ready') assert.fail(`expected a ready deployment, got ${deployment.status}`)
    return deployment
}

function readyRecordFor(id: DeploymentId, projectId: ProjectId): ReadyDeployment {
    return {
        id,
        projectId,
        commitSha: null,
        status: 'ready',
        createdAt: '2026-01-01T00:00:00Z',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:01:00Z',
    }
}

function aliasFor(db: DatabaseSync, host: Hostname): Alias {
    const alias = loadAlias(db, host)
    if (alias === null) assert.fail(`no alias ${host}`)
    return valueFrom(alias)
}

function aliasRowCount(db: DatabaseSync): number {
    const row = db.prepare('SELECT count(*) AS rows FROM aliases').get()
    if (row === undefined || typeof row.rows !== 'number') assert.fail('the alias count is not a number')
    return row.rows
}

function watchAliasDeletions(db: DatabaseSync): () => readonly string[] {
    db.exec('CREATE TEMP TABLE alias_deletions (hostname TEXT NOT NULL)')
    db.exec(
        `CREATE TEMP TRIGGER record_alias_deletions AFTER DELETE ON aliases
         BEGIN
             INSERT INTO alias_deletions (hostname) VALUES (OLD.hostname);
         END`,
    )

    return () =>
        db
            .prepare('SELECT hostname FROM alias_deletions ORDER BY rowid')
            .all()
            .map((row) => (typeof row.hostname === 'string' ? row.hostname : assert.fail('a deletion is not a string')))
}

function withAliasDatabase(run: (db: DatabaseSync, projectId: ProjectId) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'berth-aliases-'))
    try {
        const db = openDatabase(join(dir, 'berth.db'))
        try {
            run(db, insertProject(db))
        } finally {
            db.close()
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

test('pointing a hostname at a ready deployment writes an alias that reads back', () => {
    withAliasDatabase((db, projectId) => {
        const deployment = insertReady(db, projectId)
        const myapp = hostname('myapp.localhost')

        assert.equal(pointAliasAt(db, myapp, deployment), 'pointed')

        const alias = aliasFor(db, myapp)
        assert.equal(alias.hostname, myapp)
        assert.equal(alias.deploymentId, deployment.id)
        assert.match(alias.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    })
})

test('repointing a hostname swaps the deployment without ever removing the row', () => {
    withAliasDatabase((db, projectId) => {
        const first = insertReady(db, projectId)
        const second = insertReady(db, projectId)
        const myapp = hostname('myapp.localhost')
        const deletions = watchAliasDeletions(db)

        assert.equal(pointAliasAt(db, myapp, first), 'pointed')
        assert.equal(aliasRowCount(db), 1)

        assert.equal(pointAliasAt(db, myapp, second), 'pointed')
        assert.equal(aliasRowCount(db), 1)
        assert.equal(aliasFor(db, myapp).deploymentId, second.id)
        assert.deepEqual(deletions(), [])

        assert.equal(pointAliasAt(db, myapp, first), 'pointed')
        assert.equal(aliasRowCount(db), 1)
        assert.equal(aliasFor(db, myapp).deploymentId, first.id)
        assert.deepEqual(deletions(), [])
    })
})

const notReadyStatuses: readonly (readonly [string, (db: DatabaseSync, projectId: ProjectId) => DeploymentId])[] = [
    ['queued', insertQueued],
    ['building', insertBuilding],
    ['failed', insertFailed],
]

for (const [status, insertDeployment] of notReadyStatuses) {
    test(`pointing at a ${status} deployment is refused and leaves the alias alone`, () => {
        withAliasDatabase((db, projectId) => {
            const served = insertReady(db, projectId)
            const myapp = hostname('myapp.localhost')
            assert.equal(pointAliasAt(db, myapp, served), 'pointed')
            const before = aliasFor(db, myapp)

            const target = insertDeployment(db, projectId)
            assert.equal(pointAliasAt(db, myapp, readyRecordFor(target, projectId)), 'deploymentNotFound')

            assert.deepEqual(aliasFor(db, myapp), before)
            assert.equal(aliasRowCount(db), 1)
        })
    })
}

test('pointing at a deployment that does not exist is refused rather than written', () => {
    withAliasDatabase((db, projectId) => {
        const collected = readyRecordFor(newDeploymentId(), projectId)
        const myapp = hostname('myapp.localhost')

        assert.equal(pointAliasAt(db, myapp, collected), 'deploymentNotFound')
        assert.equal(loadAlias(db, myapp), null)
        assert.equal(aliasRowCount(db), 0)
    })
})

test('a refused repoint leaves the hostname on the deployment it already served', () => {
    withAliasDatabase((db, projectId) => {
        const served = insertReady(db, projectId)
        const myapp = hostname('myapp.localhost')
        assert.equal(pointAliasAt(db, myapp, served), 'pointed')

        const collected = readyRecordFor(newDeploymentId(), projectId)
        assert.equal(pointAliasAt(db, myapp, collected), 'deploymentNotFound')

        assert.equal(aliasFor(db, myapp).deploymentId, served.id)
    })
})

test('aliases list in hostname order, and per deployment', () => {
    withAliasDatabase((db, projectId) => {
        const first = insertReady(db, projectId)
        const second = insertReady(db, projectId)

        assert.equal(pointAliasAt(db, hostname('www.localhost'), first), 'pointed')
        assert.equal(pointAliasAt(db, hostname('docs.localhost'), second), 'pointed')
        assert.equal(pointAliasAt(db, hostname('app.localhost'), first), 'pointed')

        assert.deepEqual(
            valueFrom(loadAliases(db)).map((alias) => alias.hostname),
            ['app.localhost', 'docs.localhost', 'www.localhost'],
        )
        assert.deepEqual(
            valueFrom(loadAliasesForDeployment(db, first.id)).map((alias) => alias.hostname),
            ['app.localhost', 'www.localhost'],
        )
        assert.deepEqual(valueFrom(loadAliasesForDeployment(db, second.id)).map((alias) => alias.hostname), [
            'docs.localhost',
        ])
    })
})

test('deleteAlias retires a hostname once and reports the second attempt', () => {
    withAliasDatabase((db, projectId) => {
        const deployment = insertReady(db, projectId)
        const myapp = hostname('myapp.localhost')
        assert.equal(pointAliasAt(db, myapp, deployment), 'pointed')

        assert.equal(deleteAlias(db, myapp), 'deleted')
        assert.equal(loadAlias(db, myapp), null)
        assert.equal(deleteAlias(db, myapp), 'notFound')
    })
})

test('an unknown hostname reads back as no alias at all', () => {
    withAliasDatabase((db) => {
        assert.equal(loadAlias(db, hostname('nothing.localhost')), null)
        assert.deepEqual(valueFrom(loadAliases(db)), [])
    })
})

test('parseAliasHostname canonicalises case and refuses a hostname shaped like a deployment url', () => {
    assert.equal(valueFrom(parseAliasHostname('MyApp.Localhost')), 'myapp.localhost')
    assert.equal(errorFrom(parseAliasHostname('dpl_0123456789ab.localhost')), 'hostname would shadow a deployment url')
    assert.equal(errorFrom(parseAliasHostname('DPL_0123456789AB.localhost')), 'hostname would shadow a deployment url')
    assert.equal(errorFrom(parseAliasHostname('under score.localhost')), 'hostname is not a hostname')
    assert.equal(valueFrom(parseAliasHostname('dpl_notanid.localhost')), 'dpl_notanid.localhost')
})

test('parsePointAliasBody accepts a deployment id and names what is wrong otherwise', () => {
    assert.deepEqual(valueFrom(parsePointAliasBody({ deploymentId: 'dpl_0123456789ab' })), {
        deploymentId: 'dpl_0123456789ab',
    })
    assert.equal(errorFrom(parsePointAliasBody({ deploymentId: 'prj_0123456789ab' })), 'deploymentId is not a deployment id')
    assert.equal(errorFrom(parsePointAliasBody({})), 'deploymentId must be a string')
    assert.equal(errorFrom(parsePointAliasBody([])), 'expected an object, got array')
    assert.equal(errorFrom(parsePointAliasBody('dpl_0123456789ab')), 'expected an object, got string')
})

test('parseAliasRow refuses a row whose columns are not what the table promises', () => {
    assert.deepEqual(
        valueFrom(
            parseAliasRow({
                hostname: 'myapp.localhost',
                deployment_id: 'dpl_0123456789ab',
                updated_at: '2026-01-01T00:00:00Z',
            }),
        ),
        { hostname: 'myapp.localhost', deploymentId: 'dpl_0123456789ab', updatedAt: '2026-01-01T00:00:00Z' },
    )
    assert.equal(
        errorFrom(parseAliasRow({ deployment_id: 'dpl_0123456789ab', updated_at: '2026-01-01T00:00:00Z' })),
        'missing column hostname',
    )
    assert.equal(
        errorFrom(
            parseAliasRow({
                hostname: 'myapp.localhost',
                deployment_id: 'prj_0123456789ab',
                updated_at: '2026-01-01T00:00:00Z',
            }),
        ),
        'deployment_id is not a deployment id',
    )
    assert.equal(
        errorFrom(
            parseAliasRow({
                hostname: 'not a hostname',
                deployment_id: 'dpl_0123456789ab',
                updated_at: '2026-01-01T00:00:00Z',
            }),
        ),
        'hostname is not a hostname',
    )
    assert.equal(
        errorFrom(parseAliasRow({ hostname: 'myapp.localhost', deployment_id: 'dpl_0123456789ab', updated_at: 1 })),
        'column updated_at is not a string',
    )
})
