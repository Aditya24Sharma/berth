import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DeploymentId } from '#shared/ids.ts'

export function berthDataDir(): string {
    return process.env.BERTH_DATA_DIR ?? join(homedir(), '.berth')
}

export function databasePath(): string {
    return join(berthDataDir(), 'berth.db')
}

export function deploymentsDir(): string {
    return join(berthDataDir(), 'deployments')
}

export function deploymentDir(id: DeploymentId): string {
    return join(deploymentsDir(), id)
}

export function buildScratchDir(id: DeploymentId): string {
    return join(berthDataDir(), 'builds', id)
}

export function clonedRepoDir(id: DeploymentId): string {
    return join(buildScratchDir(id), 'repo')
}

export function trashDir(): string {
    return join(berthDataDir(), 'trash')
}

export function trashedDeploymentDir(id: DeploymentId): string {
    return join(trashDir(), id)
}
