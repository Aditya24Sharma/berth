import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { newDeploymentId, newProjectId, parseCommitSha } from '#shared/ids.ts'
import type { CommitSha, DeploymentId, ProjectId } from '#shared/ids.ts'
import {
    claimQueuedDeployment,
    failAbandonedDeployments,
    loadDeployment,
    markDeploymentFailed,
    markDeploymentReady,
    recordDeploymentCommit,
} from '#shared/deployments.ts'
import type { BuildingDeployment, Deployment } from '#shared/deployments.ts'

function withDatabase(body: (db: DatabaseSync) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'berth-deployments-'))
    try {
        const db = openDatabase(join(dir, 'berth.db'))
        try {
            body(db)
        } finally {
            db.close()
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

function insertOwningProject(db: DatabaseSync): ProjectId {
    const id = newProjectId()
    db.prepare(
        `INSERT INTO projects (id, name, repo_url, build_cmd, output_dir)
         VALUES (?, 'site', 'https://example.com/site.git', 'npm run build', 'dist')`,
    ).run(id)
    return id
}

function insertQueuedAt(db: DatabaseSync, projectId: ProjectId, createdAt: string): DeploymentId {
    const id = newDeploymentId()
    db.prepare('INSERT INTO deployments (id, project_id, created_at) VALUES (?, ?, ?)').run(id, projectId, createdAt)
    return id
}

function insertBuildingSince(db: DatabaseSync, projectId: ProjectId, startedAt: string): DeploymentId {
    const id = newDeploymentId()
    db.prepare(
        `INSERT INTO deployments (id, project_id, status, created_at, started_at)
         VALUES (?, ?, 'building', ?, ?)`,
    ).run(id, projectId, startedAt, startedAt)
    return id
}

function claimOrThrow(db: DatabaseSync): BuildingDeployment {
    const claim = claimQueuedDeployment(db)
    if (claim === null) throw new Error('expected a claim, the queue was empty')
    if (!claim.ok) throw new Error(claim.error)
    return claim.value
}

function loadOrThrow(db: DatabaseSync, id: DeploymentId): Deployment {
    const deployment = loadDeployment(db, id)
    if (deployment === null) throw new Error(`no deployment ${id}`)
    if (!deployment.ok) throw new Error(deployment.error)
    return deployment.value
}

function sweepOrThrow(db: DatabaseSync, olderThanSeconds: number, error: string): readonly DeploymentId[] {
    const swept = failAbandonedDeployments(db, olderThanSeconds, error)
    if (!swept.ok) throw new Error(swept.error)
    return swept.value
}

function requireCommitSha(value: string): CommitSha {
    const commitSha = parseCommitSha(value)
    if (commitSha === null) throw new Error(`not a commit sha: ${value}`)
    return commitSha
}

test('claims run oldest first and break a created_at tie by id', () => {
    withDatabase((db) => {
        const projectId = insertOwningProject(db)

        const tied = [newDeploymentId(), newDeploymentId()].sort()
        const [firstTied, secondTied] = tied
        if (firstTied === undefined || secondTied === undefined) throw new Error('expected two tied ids')

        const insert = db.prepare('INSERT INTO deployments (id, project_id, created_at) VALUES (?, ?, ?)')
        insert.run(secondTied, projectId, '2026-01-01T00:00:00Z')
        insert.run(firstTied, projectId, '2026-01-01T00:00:00Z')
        const newest = insertQueuedAt(db, projectId, '2026-01-01T00:00:05Z')

        assert.equal(claimOrThrow(db).id, firstTied)
        assert.equal(claimOrThrow(db).id, secondTied)
        assert.equal(claimOrThrow(db).id, newest)
        assert.equal(claimQueuedDeployment(db), null)
    })
})

test('a claim returns a building deployment and never one already building', () => {
    withDatabase((db) => {
        const projectId = insertOwningProject(db)
        const alreadyBuilding = insertBuildingSince(db, projectId, '2026-01-01T00:00:00Z')
        const queued = insertQueuedAt(db, projectId, '2026-01-01T00:00:01Z')

        const claimed = claimOrThrow(db)
        assert.equal(claimed.id, queued)
        assert.equal(claimed.status, 'building')
        assert.match(claimed.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

        assert.equal(claimQueuedDeployment(db), null)
        assert.equal(loadOrThrow(db, alreadyBuilding).status, 'building')
    })
})

test('a terminal write applies once and is ignored thereafter', () => {
    withDatabase((db) => {
        const projectId = insertOwningProject(db)
        insertQueuedAt(db, projectId, '2026-01-01T00:00:00Z')
        const claimed = claimOrThrow(db)

        assert.equal(markDeploymentReady(db, claimed.id), 'applied')
        assert.equal(markDeploymentReady(db, claimed.id), 'ignored')
        assert.equal(markDeploymentFailed(db, claimed.id, 'too late'), 'ignored')

        const finished = loadOrThrow(db, claimed.id)
        assert.equal(finished.status, 'ready')
    })
})

test('markDeploymentFailed records the error and is then terminal', () => {
    withDatabase((db) => {
        const projectId = insertOwningProject(db)
        insertQueuedAt(db, projectId, '2026-01-01T00:00:00Z')
        const claimed = claimOrThrow(db)

        assert.equal(markDeploymentFailed(db, claimed.id, 'build exited 1'), 'applied')
        assert.equal(markDeploymentFailed(db, claimed.id, 'build exited 1'), 'ignored')
        assert.equal(markDeploymentReady(db, claimed.id), 'ignored')

        const finished = loadOrThrow(db, claimed.id)
        if (finished.status !== 'failed') throw new Error(`expected failed, got ${finished.status}`)
        assert.equal(finished.error, 'build exited 1')
    })
})

test('the database refuses a ready to building transition', () => {
    withDatabase((db) => {
        const projectId = insertOwningProject(db)
        insertQueuedAt(db, projectId, '2026-01-01T00:00:00Z')
        const claimed = claimOrThrow(db)
        assert.equal(markDeploymentReady(db, claimed.id), 'applied')

        assert.throws(
            () => db.prepare("UPDATE deployments SET status = 'building' WHERE id = ?").run(claimed.id),
            /illegal deployment status transition/,
        )
    })
})

test('recordDeploymentCommit sets the sha and leaves the deployment building', () => {
    withDatabase((db) => {
        const projectId = insertOwningProject(db)
        insertQueuedAt(db, projectId, '2026-01-01T00:00:00Z')
        const claimed = claimOrThrow(db)
        assert.equal(claimed.commitSha, null)

        const commitSha = requireCommitSha('0123456789abcdef0123456789abcdef01234567')
        recordDeploymentCommit(db, claimed.id, commitSha)

        const recorded = loadOrThrow(db, claimed.id)
        assert.equal(recorded.status, 'building')
        assert.equal(recorded.commitSha, commitSha)
    })
})

test('the abandoned sweep fails builds older than the age and leaves fresh ones alone', () => {
    withDatabase((db) => {
        const projectId = insertOwningProject(db)
        const abandoned = insertBuildingSince(db, projectId, '2020-01-01T00:00:00Z')
        insertQueuedAt(db, projectId, '2026-01-01T00:00:00Z')
        const fresh = claimOrThrow(db)

        assert.deepEqual(sweepOrThrow(db, 60, 'the worker vanished'), [abandoned])

        const swept = loadOrThrow(db, abandoned)
        if (swept.status !== 'failed') throw new Error(`expected failed, got ${swept.status}`)
        assert.equal(swept.error, 'the worker vanished')

        assert.equal(loadOrThrow(db, fresh.id).status, 'building')
        assert.deepEqual(sweepOrThrow(db, 60, 'the worker vanished'), [])
    })
})
