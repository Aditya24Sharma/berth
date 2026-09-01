import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
    parseCommitSha,
    parseDeploymentId,
    parseProjectId,
    type CommitSha,
    type DeploymentId,
    type ProjectId,
} from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { optionalColumn, requiredColumn } from '#shared/columns.ts'

type DeploymentCommon = {
    readonly id: DeploymentId
    readonly projectId: ProjectId
    readonly commitSha: CommitSha | null
    readonly createdAt: string
}

export type QueuedDeployment = DeploymentCommon & {
    readonly status: 'queued'
}

export type BuildingDeployment = DeploymentCommon & {
    readonly status: 'building'
    readonly startedAt: string
}

export type ReadyDeployment = DeploymentCommon & {
    readonly status: 'ready'
    readonly startedAt: string
    readonly finishedAt: string
}

export type FailedDeployment = DeploymentCommon & {
    readonly status: 'failed'
    readonly startedAt: string
    readonly finishedAt: string
    readonly error: string
}

export type Deployment =
    | QueuedDeployment
    | BuildingDeployment
    | ReadyDeployment
    | FailedDeployment

export type StatusWrite = 'applied' | 'ignored'

export type RetentionPolicy = {
    readonly keepPerProject: number
    readonly retentionDays: number
}

function deploymentIdColumn(value: SQLOutputValue | undefined): Parsed<DeploymentId> {
    const column = requiredColumn(value, 'id')
    if (!column.ok) return column

    const id = parseDeploymentId(column.value)
    if (id === null) return invalid('id is not a deployment id')
    return valid(id)
}

function commitShaColumn(value: SQLOutputValue | undefined): Parsed<CommitSha | null> {
    const column = optionalColumn(value, 'commit_sha')
    if (!column.ok) return column
    if (column.value === null) return valid(null)

    const commitSha = parseCommitSha(column.value)
    if (commitSha === null) return invalid('commit_sha is not a full commit sha')
    return valid(commitSha)
}

export function parseDeploymentRow(row: Record<string, SQLOutputValue>): Parsed<Deployment> {
    const deploymentId = deploymentIdColumn(row.id)
    if (!deploymentId.ok) return deploymentId

    const projectIdColumn = requiredColumn(row.project_id, 'project_id')
    if (!projectIdColumn.ok) return projectIdColumn

    const projectId = parseProjectId(projectIdColumn.value)
    if (projectId === null) return invalid('project_id is not a project id')

    const commitSha = commitShaColumn(row.commit_sha)
    if (!commitSha.ok) return commitSha

    const createdAt = requiredColumn(row.created_at, 'created_at')
    if (!createdAt.ok) return createdAt

    const status = requiredColumn(row.status, 'status')
    if (!status.ok) return status

    const common: DeploymentCommon = {
        id: deploymentId.value,
        projectId,
        commitSha: commitSha.value,
        createdAt: createdAt.value,
    }

    switch (status.value) {
        case 'failed': {
            const startedAt = requiredColumn(row.started_at, 'started_at')
            if (!startedAt.ok) return startedAt

            const finishedAt = requiredColumn(row.finished_at, 'finished_at')
            if (!finishedAt.ok) return finishedAt

            const error = requiredColumn(row.error, 'error')
            if (!error.ok) return error

            return valid({
                ...common,
                status: 'failed',
                startedAt: startedAt.value,
                finishedAt: finishedAt.value,
                error: error.value,
            })
        }

        case 'ready': {
            const startedAt = requiredColumn(row.started_at, 'started_at')
            if (!startedAt.ok) return startedAt

            const finishedAt = requiredColumn(row.finished_at, 'finished_at')
            if (!finishedAt.ok) return finishedAt

            return valid({
                ...common,
                status: 'ready',
                startedAt: startedAt.value,
                finishedAt: finishedAt.value,
            })
        }

        case 'building': {
            const startedAt = requiredColumn(row.started_at, 'started_at')
            if (!startedAt.ok) return startedAt

            return valid({
                ...common,
                status: 'building',
                startedAt: startedAt.value,
            })
        }

        case 'queued': {
            return valid({
                ...common,
                status: 'queued',
            })
        }

        default:
            return invalid(`invalid deployment status: ${status.value}`)
    }
}

export function insertQueuedDeployment(db: DatabaseSync, id: DeploymentId, projectId: ProjectId): void {
    db.prepare('INSERT INTO deployments (id, project_id) VALUES (?, ?)').run(id, projectId)
}

export function loadDeployment(db: DatabaseSync, id: DeploymentId): Parsed<Deployment> | null {
    const row = db.prepare('SELECT * FROM deployments WHERE id = ?').get(id)
    return row === undefined ? null : parseDeploymentRow(row)
}

function parseDeploymentRows(rows: readonly Record<string, SQLOutputValue>[]): Parsed<readonly Deployment[]> {
    const deployments: Deployment[] = []

    for (const row of rows) {
        const deployment = parseDeploymentRow(row)
        if (!deployment.ok) return deployment
        deployments.push(deployment.value)
    }

    return valid(deployments)
}

export function loadProjectDeployments(
    db: DatabaseSync,
    projectId: ProjectId,
    limit: number,
): Parsed<readonly Deployment[]> {
    const rows = db
        .prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(projectId, limit)

    return parseDeploymentRows(rows)
}

export function loadRecentDeployments(db: DatabaseSync, limit: number): Parsed<readonly Deployment[]> {
    const rows = db.prepare('SELECT * FROM deployments ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)

    return parseDeploymentRows(rows)
}

export function claimQueuedDeployment(db: DatabaseSync): Parsed<BuildingDeployment> | null {
    const [row] = db
        .prepare(
            `UPDATE deployments
                SET status     = 'building',
                    started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE id = (
                      SELECT id
                        FROM deployments
                       WHERE status = 'queued'
                       ORDER BY created_at, id
                       LIMIT 1
                    )
                AND status = 'queued'
             RETURNING *`,
        )
        .all()

    if (row === undefined) return null

    const deployment = parseDeploymentRow(row)
    if (!deployment.ok) return deployment
    if (deployment.value.status !== 'building') {
        return invalid(`claimed deployment ${deployment.value.id} is ${deployment.value.status}`)
    }

    return valid(deployment.value)
}

export function recordDeploymentCommit(db: DatabaseSync, id: DeploymentId, commitSha: CommitSha): void {
    db.prepare("UPDATE deployments SET commit_sha = ? WHERE id = ? AND status = 'building'").run(commitSha, id)
}

export function markDeploymentReady(db: DatabaseSync, id: DeploymentId): StatusWrite {
    const written = db
        .prepare(
            `UPDATE deployments
                SET status      = 'ready',
                    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
              WHERE id = ? AND status = 'building'`,
        )
        .run(id)

    return written.changes > 0 ? 'applied' : 'ignored'
}

export function markDeploymentFailed(db: DatabaseSync, id: DeploymentId, error: string): StatusWrite {
    const written = db
        .prepare(
            `UPDATE deployments
                SET status      = 'failed',
                    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                    error       = ?
              WHERE id = ? AND status = 'building'`,
        )
        .run(error, id)

    return written.changes > 0 ? 'applied' : 'ignored'
}

export function failAbandonedDeployments(
    db: DatabaseSync,
    olderThanSeconds: number,
    error: string,
): Parsed<readonly DeploymentId[]> {
    const rows = db
        .prepare(
            `UPDATE deployments
                SET status      = 'failed',
                    finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                    error       = ?
              WHERE status = 'building'
                AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
          RETURNING id`,
        )
        .all(error, `-${olderThanSeconds} seconds`)

    const abandoned: DeploymentId[] = []

    for (const row of rows) {
        const id = deploymentIdColumn(row.id)
        if (!id.ok) return id
        abandoned.push(id.value)
    }

    return valid(abandoned)
}
