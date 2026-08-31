import { randomBytes } from 'node:crypto'

declare const kind: unique symbol

export type ProjectId = string & { readonly [kind]: 'project' }
export type DeploymentId = string & { readonly [kind]: 'deployment' }

function randomSuffix(): string {
    return randomBytes(6).toString('hex')
}

export function newProjectId(): ProjectId {
    return `prj_${randomSuffix()}` as ProjectId
}

export function newDeploymentId(): DeploymentId {
    return `dpl_${randomSuffix()}` as DeploymentId
}

export function parseProjectId(value: string): ProjectId | null {
    return /^prj_[0-9a-f]{12}$/.test(value) ? (value as ProjectId) : null
}

export function parseDeploymentId(value: string): DeploymentId | null {
    return /^dpl_[0-9a-f]{12}$/.test(value) ? (value as DeploymentId) : null
}
