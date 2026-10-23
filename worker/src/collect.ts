import { existsSync, lstatSync, readdirSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { RetentionPolicy } from '#shared/deployments.ts'
import { parseDeploymentId, type DeploymentId } from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { deploymentDir, deploymentsDir } from '#shared/paths.ts'
import { deleteUnreferencedDeployments, loadDeploymentIds } from '#shared/retention.ts'
import { clearTrash, trashDeploymentDirectory } from './publish.ts'

export type CollectionFailure =
    | { readonly kind: 'retentionSweepFailed'; readonly error: string }
    | { readonly kind: 'orphanSweepFailed'; readonly error: string }
    | { readonly kind: 'directoryNotRemoved'; readonly id: DeploymentId; readonly error: string }

export type CollectionReport = {
    readonly collectedDeployments: readonly DeploymentId[]
    readonly collectedOrphanDirectories: readonly DeploymentId[]
    readonly skippedNames: readonly string[]
    readonly failures: readonly CollectionFailure[]
}

type DirectoryRemoval =
    | { readonly kind: 'removed' }
    | { readonly kind: 'alreadyGone' }
    | { readonly kind: 'notRemoved'; readonly error: string }

type StoredDirectory = {
    readonly id: DeploymentId
    readonly modifiedAtMs: number
}

type StoreListing = {
    readonly directories: readonly StoredDirectory[]
    readonly skippedNames: readonly string[]
}

function removeDeploymentDirectory(id: DeploymentId): DirectoryRemoval {
    const trashed = trashDeploymentDirectory(id)
    if (trashed.ok) return { kind: 'removed' }
    if (lstatSync(deploymentDir(id), { throwIfNoEntry: false }) === undefined) return { kind: 'alreadyGone' }
    return { kind: 'notRemoved', error: trashed.error }
}

function readStoreListing(): Parsed<StoreListing> {
    const store = deploymentsDir()
    if (!existsSync(store)) return valid({ directories: [], skippedNames: [] })

    let names: readonly string[]
    try {
        names = readdirSync(store)
    } catch (error) {
        if (!(error instanceof Error)) throw error
        return invalid(`could not read ${store}: ${error.message}`)
    }

    const directories: StoredDirectory[] = []
    const skippedNames: string[] = []

    for (const name of names) {
        const id = parseDeploymentId(name)
        if (id === null) {
            skippedNames.push(name)
            continue
        }

        const entry = lstatSync(deploymentDir(id), { throwIfNoEntry: false })
        if (entry === undefined) continue
        if (!entry.isDirectory()) {
            skippedNames.push(name)
            continue
        }

        directories.push({ id, modifiedAtMs: entry.mtimeMs })
    }

    return valid({ directories, skippedNames })
}

export function collectUnreferencedDeployments(
    db: DatabaseSync,
    policy: RetentionPolicy,
    orphanMinimumAgeMs: number,
): CollectionReport {
    const failures: CollectionFailure[] = []
    const collectedDeployments: DeploymentId[] = []
    const collectedOrphanDirectories: DeploymentId[] = []
    const skippedNames: string[] = []

    // The row goes first. A crash between the two leaves a directory nothing resolves to,
    // which the orphan sweep below reclaims on a later pass; the other order would leave a
    // ready row whose files are gone and the proxy would 404 a deployment the database
    // says is live.
    const deleted = deleteUnreferencedDeployments(db, policy)
    if (!deleted.ok) {
        failures.push({ kind: 'retentionSweepFailed', error: deleted.error })
    } else {
        for (const id of deleted.value) {
            collectedDeployments.push(id)
            const removal = removeDeploymentDirectory(id)
            if (removal.kind === 'notRemoved') {
                failures.push({ kind: 'directoryNotRemoved', id, error: removal.error })
            }
        }
    }

    const known = loadDeploymentIds(db)
    const listing = readStoreListing()
    if (!known.ok) failures.push({ kind: 'orphanSweepFailed', error: known.error })
    if (!listing.ok) failures.push({ kind: 'orphanSweepFailed', error: listing.error })

    if (known.ok && listing.ok) {
        skippedNames.push(...listing.value.skippedNames)

        const orphanedBefore = Date.now() - orphanMinimumAgeMs
        for (const directory of listing.value.directories) {
            if (known.value.has(directory.id)) continue
            if (directory.modifiedAtMs >= orphanedBefore) continue

            const removal = removeDeploymentDirectory(directory.id)
            if (removal.kind === 'notRemoved') {
                failures.push({ kind: 'directoryNotRemoved', id: directory.id, error: removal.error })
                continue
            }
            collectedOrphanDirectories.push(directory.id)
        }
    }

    clearTrash()

    return { collectedDeployments, collectedOrphanDirectories, skippedNames, failures }
}
