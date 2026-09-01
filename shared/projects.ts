import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { ProjectId, RepoUrl } from '#shared/ids.ts'
import type { JsonValue, Parsed } from '#shared/json.ts'
import { parseProjectId, parseRepoUrl } from '#shared/ids.ts'
import { invalid, isJsonObject, requiredString, valid } from '#shared/json.ts'
import { requiredColumn } from '#shared/columns.ts'

export type Project = {
    readonly id: ProjectId
    readonly name: string
    readonly repoUrl: RepoUrl
    readonly buildCmd: string
    readonly outputDir: string
    readonly createdAt: string
}

export type CreateProjectBody = {
    readonly name: string
    readonly repoUrl: RepoUrl
    readonly buildCmd: string
    readonly outputDir: string
}

function isRelativePathInsideRepository(path: string): boolean {
    return !path.startsWith('/') && !path.split('/').includes('..')
}

export function parseCreateProjectBody(body: JsonValue): Parsed<CreateProjectBody> {
    if (!isJsonObject(body)) {
        const got = Array.isArray(body) ? 'array' : typeof body
        return invalid(`expected an object, got ${got}`)
    }

    const name = requiredString(body['name'], 'name')
    if (!name.ok) return name

    const repoUrlString = requiredString(body['repoUrl'], 'repoUrl')
    if (!repoUrlString.ok) return repoUrlString

    const repoUrl = parseRepoUrl(repoUrlString.value)
    if (repoUrl === null) return invalid('repoUrl must be an https url')

    const buildCmd = requiredString(body['buildCmd'], 'buildCmd')
    if (!buildCmd.ok) return buildCmd

    const outputDir = requiredString(body['outputDir'], 'outputDir')
    if (!outputDir.ok) return outputDir

    if (!isRelativePathInsideRepository(outputDir.value)) {
        return invalid('outputDir must be a relative path inside the repository')
    }

    return valid({
        name: name.value,
        repoUrl,
        buildCmd: buildCmd.value,
        outputDir: outputDir.value,
    })
}

export function parseProjectRow(row: Record<string, SQLOutputValue>): Parsed<Project> {
    const idColumn = requiredColumn(row.id, 'id')
    if (!idColumn.ok) return idColumn

    const name = requiredColumn(row.name, 'name')
    if (!name.ok) return name

    const repoUrlColumn = requiredColumn(row.repo_url, 'repo_url')
    if (!repoUrlColumn.ok) return repoUrlColumn

    const repoUrl = parseRepoUrl(repoUrlColumn.value)
    if (repoUrl === null) return invalid('repoUrl must be an https url')

    const buildCmd = requiredColumn(row.build_cmd, 'build_cmd')
    if (!buildCmd.ok) return buildCmd

    const outputDir = requiredColumn(row.output_dir, 'output_dir')
    if (!outputDir.ok) return outputDir

    const createdAt = requiredColumn(row.created_at, 'created_at')
    if (!createdAt.ok) return createdAt

    const projectId = parseProjectId(idColumn.value)
    if (projectId === null) return invalid('id is not a project id')

    return valid({
        id: projectId,
        name: name.value,
        repoUrl,
        buildCmd: buildCmd.value,
        outputDir: outputDir.value,
        createdAt: createdAt.value,
    })
}

export function insertProject(db: DatabaseSync, id: ProjectId, body: CreateProjectBody): void {
    db.prepare(
        `INSERT INTO projects (id, name, repo_url, build_cmd, output_dir)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(id, body.name, body.repoUrl, body.buildCmd, body.outputDir)
}

export function loadProject(db: DatabaseSync, id: ProjectId): Parsed<Project> | null {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    return row === undefined ? null : parseProjectRow(row)
}

export function loadProjects(db: DatabaseSync): Parsed<readonly Project[]> {
    const projects: Project[] = []

    for (const row of db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()) {
        const project = parseProjectRow(row)
        if (!project.ok) return project
        projects.push(project.value)
    }

    return valid(projects)
}
