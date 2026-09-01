import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { ProjectId } from "#shared/ids.ts";
import type { JsonValue, Parsed } from "#shared/json.ts";
import { parseProjectId } from "#shared/ids.ts";
import { invalid, isJsonObject, valid } from "#shared/json.ts";
import { requiredColumn } from "./columns.ts";

export type Project = {
    readonly id: ProjectId;
    readonly name: string;
    readonly repoUrl: string;
    readonly buildCmd: string;
    readonly outputDir: string;
    readonly createdAt: string;
};

export type CreateProjectBody = {
    readonly name: string;
    readonly repoUrl: string;
    readonly buildCmd: string;
    readonly outputDir: string;
};

function requiredString(
    value: JsonValue | undefined,
    field: string,
): Parsed<string> {
    if (typeof value !== "string") return invalid(`${field} must be a string`);
    if (value.length === 0) return invalid(`${field} must not be empty`);
    return valid(value);
}

export function parseCreateProjectBody(
    body: JsonValue,
): Parsed<CreateProjectBody> {
    if (!isJsonObject(body)) {
        const got = Array.isArray(body) ? "array" : typeof body;
        return invalid(`expected an object, got ${got}`);
    }

    const name = requiredString(body["name"], "name");
    if (!name.ok) return name;

    const repoUrl = requiredString(body["repoUrl"], "repoUrl");
    if (!repoUrl.ok) return repoUrl;

    const buildCmd = requiredString(body["buildCmd"], "buildCmd");
    if (!buildCmd.ok) return buildCmd;

    const outputDir = requiredString(body["outputDir"], "outputDir");
    if (!outputDir.ok) return outputDir;

    return valid({
        name: name.value,
        repoUrl: repoUrl.value,
        buildCmd: buildCmd.value,
        outputDir: outputDir.value,
    });
}

export function parseProjectRow(
    row: Record<string, SQLOutputValue>,
): Parsed<Project> {
    const idColumn = requiredColumn(row.id, "id");
    if (!idColumn.ok) return idColumn;

    const name = requiredColumn(row.name, "name");
    if (!name.ok) return name;

    const repoUrl = requiredColumn(row.repo_url, "repo_url");
    if (!repoUrl.ok) return repoUrl;

    const buildCmd = requiredColumn(row.build_cmd, "build_cmd");
    if (!buildCmd.ok) return buildCmd;

    const outputDir = requiredColumn(row.output_dir, "output_dir");
    if (!outputDir.ok) return outputDir;

    const createdAt = requiredColumn(row.created_at, "created_at");
    if (!createdAt.ok) return createdAt;

    const projectId = parseProjectId(idColumn.value);
    if (projectId === null) return invalid("id is not a project id");

    return valid({
        id: projectId,
        name: name.value,
        repoUrl: repoUrl.value,
        buildCmd: buildCmd.value,
        outputDir: outputDir.value,
        createdAt: createdAt.value,
    });
}

export function insertProject(
    db: DatabaseSync,
    id: ProjectId,
    body: CreateProjectBody,
): void {
    db.prepare(
        `INSERT INTO projects (id, name, repo_url, build_cmd, output_dir)
         VALUES (?, ?, ?, ?, ?)`,
    ).run(id, body.name, body.repoUrl, body.buildCmd, body.outputDir);
}

export function projectExists(db: DatabaseSync, id: ProjectId): boolean {
    return (
        db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id) !== undefined
    );
}

export function loadProjects(db: DatabaseSync): Parsed<readonly Project[]> {
    const projects: Project[] = [];

    for (const row of db
        .prepare("SELECT * FROM projects ORDER BY created_at DESC")
        .all()) {
        const project = parseProjectRow(row);
        if (!project.ok) return project;
        projects.push(project.value);
    }

    return valid(projects);
}
