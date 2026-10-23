import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { parseDeploymentId, type DeploymentId } from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { requiredColumn } from '#shared/columns.ts'
import type { RetentionPolicy } from '#shared/deployments.ts'

function deploymentIdColumn(value: SQLOutputValue | undefined): Parsed<DeploymentId> {
    const column = requiredColumn(value, 'id')
    if (!column.ok) return column

    const id = parseDeploymentId(column.value)
    if (id === null) return invalid('id is not a deployment id')
    return valid(id)
}

// The orphan sweep asks what the store may keep, so this includes queued and building
// rows: a directory renamed into place by a build that has not yet marked itself ready
// still belongs to a deployment the database knows about.
export function loadDeploymentIds(db: DatabaseSync): Parsed<ReadonlySet<DeploymentId>> {
    const known = new Set<DeploymentId>()

    for (const row of db.prepare('SELECT id FROM deployments').all()) {
        const id = deploymentIdColumn(row.id)
        if (!id.ok) return id
        known.add(id.value)
    }

    return valid(known)
}

function isWholeNumber(value: number): boolean {
    return Number.isInteger(value) && value >= 0
}

// A negative keepPerProject makes the newest-N count comparison vacuously true and a
// negative retentionDays makes SQLite's date modifier invalid, so the policy is checked
// rather than trusted: this is the one statement in the system that destroys build output.
function checkPolicy(policy: RetentionPolicy): Parsed<RetentionPolicy> {
    if (!isWholeNumber(policy.keepPerProject)) {
        return invalid(`keepPerProject is not a whole number: ${policy.keepPerProject}`)
    }
    if (!isWholeNumber(policy.retentionDays)) {
        return invalid(`retentionDays is not a whole number: ${policy.retentionDays}`)
    }
    return valid(policy)
}

// Choosing and deleting in one statement is what makes the alias check trustworthy. A
// SELECT followed by a separate DELETE leaves a gap in which an alias can be pointed at a
// row already chosen for deletion; here SQLite's single writer holds the lock across both.
// The row-value comparison gives the newest-N count a total order that a bare created_at
// comparison loses whenever two deployments of a project share a second.
export function deleteUnreferencedDeployments(
    db: DatabaseSync,
    policy: RetentionPolicy,
): Parsed<readonly DeploymentId[]> {
    const checked = checkPolicy(policy)
    if (!checked.ok) return checked

    const rows = db
        .prepare(
            `DELETE FROM deployments
              WHERE id IN (
                    SELECT d.id
                      FROM deployments d
                     WHERE d.status IN ('ready', 'failed')
                       AND d.finished_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
                       AND NOT EXISTS (SELECT 1 FROM aliases a WHERE a.deployment_id = d.id)
                       AND (
                             SELECT count(*)
                               FROM deployments newer
                              WHERE newer.project_id = d.project_id
                                AND newer.status     = 'ready'
                                AND (newer.created_at, newer.id) > (d.created_at, d.id)
                           ) >= ?
                    )
          RETURNING id`,
        )
        .all(`-${policy.retentionDays} days`, policy.keepPerProject)

    const collected: DeploymentId[] = []

    for (const row of rows) {
        const id = deploymentIdColumn(row.id)
        if (!id.ok) return id
        collected.push(id.value)
    }

    return valid(collected)
}
