import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { DeploymentId, Hostname } from '#shared/ids.ts'
import { firstLabel, parseDeploymentId, parseHostname } from '#shared/ids.ts'
import { invalid, isJsonObject, requiredString, valid } from '#shared/json.ts'
import type { JsonValue, Parsed } from '#shared/json.ts'
import { requiredColumn } from '#shared/columns.ts'
import type { ReadyDeployment } from '#shared/deployments.ts'

export type Alias = {
    readonly hostname: Hostname
    readonly deploymentId: DeploymentId
    readonly updatedAt: string
}

export type PointAliasBody = {
    readonly deploymentId: DeploymentId
}

export type AliasWrite = 'pointed' | 'deploymentNotFound'
export type AliasDelete = 'deleted' | 'notFound'

export function parseAliasRow(row: Record<string, SQLOutputValue>): Parsed<Alias> {
    const hostnameColumn = requiredColumn(row.hostname, 'hostname')
    if (!hostnameColumn.ok) return hostnameColumn

    const hostname = parseHostname(hostnameColumn.value)
    if (hostname === null) return invalid('hostname is not a hostname')

    const deploymentIdColumn = requiredColumn(row.deployment_id, 'deployment_id')
    if (!deploymentIdColumn.ok) return deploymentIdColumn

    const deploymentId = parseDeploymentId(deploymentIdColumn.value)
    if (deploymentId === null) return invalid('deployment_id is not a deployment id')

    const updatedAt = requiredColumn(row.updated_at, 'updated_at')
    if (!updatedAt.ok) return updatedAt

    return valid({ hostname, deploymentId, updatedAt: updatedAt.value })
}

export function parsePointAliasBody(body: JsonValue): Parsed<PointAliasBody> {
    if (!isJsonObject(body)) {
        const got = Array.isArray(body) ? 'array' : typeof body
        return invalid(`expected an object, got ${got}`)
    }

    const deploymentIdString = requiredString(body['deploymentId'], 'deploymentId')
    if (!deploymentIdString.ok) return deploymentIdString

    const deploymentId = parseDeploymentId(deploymentIdString.value)
    if (deploymentId === null) return invalid('deploymentId is not a deployment id')

    return valid({ deploymentId })
}

// Every deployment is promised <id>.localhost, and the proxy resolves that form straight
// from the deployments table without ever consulting the aliases table. An alias whose
// first label is a deployment id could therefore never be served, and would shadow a URL
// that is supposed to be immutable.
export function parseAliasHostname(value: string): Parsed<Hostname> {
    const hostname = parseHostname(value)
    if (hostname === null) return invalid('hostname is not a hostname')
    if (parseDeploymentId(firstLabel(hostname)) !== null) {
        return invalid('hostname would shadow a deployment url')
    }
    return valid(hostname)
}

// One statement is one implicit transaction, so the hostname goes from pointing at the old
// deployment to pointing at the new one with nothing in between. A DELETE then an INSERT
// would leave a moment where the hostname resolves to nothing, and the SELECT source is
// what refuses a target the database no longer holds as ready.
export function pointAliasAt(db: DatabaseSync, hostname: Hostname, deployment: ReadyDeployment): AliasWrite {
    const written = db
        .prepare(
            `INSERT INTO aliases (hostname, deployment_id, updated_at)
             SELECT ?, d.id, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
               FROM deployments d
              WHERE d.id = ? AND d.status = 'ready'
                 ON CONFLICT (hostname) DO UPDATE
                    SET deployment_id = excluded.deployment_id,
                        updated_at    = excluded.updated_at`,
        )
        .run(hostname, deployment.id)

    return written.changes > 0 ? 'pointed' : 'deploymentNotFound'
}

export function loadAlias(db: DatabaseSync, hostname: Hostname): Parsed<Alias> | null {
    const row = db.prepare('SELECT * FROM aliases WHERE hostname = ?').get(hostname)
    return row === undefined ? null : parseAliasRow(row)
}

function parseAliasRows(rows: readonly Record<string, SQLOutputValue>[]): Parsed<readonly Alias[]> {
    const aliases: Alias[] = []

    for (const row of rows) {
        const alias = parseAliasRow(row)
        if (!alias.ok) return alias
        aliases.push(alias.value)
    }

    return valid(aliases)
}

export function loadAliases(db: DatabaseSync): Parsed<readonly Alias[]> {
    return parseAliasRows(db.prepare('SELECT * FROM aliases ORDER BY hostname').all())
}

export function loadAliasesForDeployment(db: DatabaseSync, id: DeploymentId): Parsed<readonly Alias[]> {
    return parseAliasRows(db.prepare('SELECT * FROM aliases WHERE deployment_id = ? ORDER BY hostname').all(id))
}

export function deleteAlias(db: DatabaseSync, hostname: Hostname): AliasDelete {
    const written = db.prepare('DELETE FROM aliases WHERE hostname = ?').run(hostname)
    return written.changes > 0 ? 'deleted' : 'notFound'
}
