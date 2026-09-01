import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { parseDeploymentId, parseProjectId, type DeploymentId, type ProjectId } from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { requiredColumn } from '#shared/columns.ts'

type DeploymentCommon = {
    readonly id: DeploymentId
    readonly projectId: ProjectId
    readonly commitSha: string | null
    readonly createdAt: string
}

export type Deployment = DeploymentCommon &
    (
        | { readonly status: 'queued' }
        | { readonly status: 'building'; readonly startedAt: string }
        | { readonly status: 'ready'; readonly startedAt: string; readonly finishedAt: string }
        | {
            readonly status: 'failed'
            readonly startedAt: string
            readonly finishedAt: string
            readonly error: string
        }
    )

export function parseDeploymentRow(row: Record<string, SQLOutputValue>): Parsed<Deployment> {
    const idColumn = requiredColumn(row.id, 'id')
    if (!idColumn.ok) return idColumn

    const deploymentId = parseDeploymentId(idColumn.value)
    if (deploymentId === null) return invalid('id is not a deployment id')

    const projectIdColumn = requiredColumn(row.project_id, 'project_id')
    if (!projectIdColumn.ok) return projectIdColumn

    const projectId = parseProjectId(projectIdColumn.value)
    if (projectId === null) return invalid('project_id is not a project id')

    const commitSha = row.commit_sha === null ? null : requiredColumn(row.commit_sha, 'commit_sha')
    if (commitSha !== null && !commitSha.ok) return commitSha

    const createdAt = requiredColumn(row.created_at, 'created_at')
    if (!createdAt.ok) return createdAt

    const status = requiredColumn(row.status, 'status')
    if (!status.ok) return status

    const common: DeploymentCommon = {
        id: deploymentId,
        projectId,
        commitSha: commitSha === null ? null : commitSha.value,
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
