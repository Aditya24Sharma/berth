import { randomBytes } from 'node:crypto'

declare const kind: unique symbol

export type ProjectId = string & { readonly [kind]: 'project' }
export type DeploymentId = string & { readonly [kind]: 'deployment' }
export type CommitSha = string & { readonly [kind]: 'commit' }
export type RepoUrl = string & { readonly [kind]: 'repo' }
export type Hostname = string & { readonly [kind]: 'hostname' }

// Underscore is not an RFC 1123 hostname character, but a deployment id contains one
// and every deployment is promised a URL at <id>.localhost. macOS resolves such a name
// to 127.0.0.1, so the id format wins and this accepts it.
const LABEL = '[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?'
const HOSTNAME = new RegExp(`^${LABEL}(\\.${LABEL})*$`)

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

export function parseCommitSha(value: string): CommitSha | null {
    return /^[0-9a-f]{40}$/.test(value) ? (value as CommitSha) : null
}

export function parseRepoUrl(value: string): RepoUrl | null {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return null
    }

    if (url.protocol !== 'https:') return null
    if (url.username !== '' || url.password !== '') return null
    if (url.hostname === '') return null

    // new URL strips surrounding whitespace and any tab or newline inside the input, so
    // the string it validated is not always the string it was given. Returning the
    // canonical form is what keeps git from ever seeing the difference.
    return url.href as RepoUrl
}

// DNS names are case-insensitive, so lowercasing is canonicalisation rather than
// mutation — and it is what makes the schema's hostname_is_lowercase CHECK
// unreachable from application code.
export function parseHostname(value: string): Hostname | null {
    const canonical = value.toLowerCase()
    if (canonical.length === 0 || canonical.length > 253) return null
    return HOSTNAME.test(canonical) ? (canonical as Hostname) : null
}

export function firstLabel(hostname: Hostname): string {
    const dot = hostname.indexOf('.')
    return dot === -1 ? hostname : hostname.slice(0, dot)
}
