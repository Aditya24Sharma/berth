import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { newDeploymentId, newProjectId, parseDeploymentId } from '#shared/ids.ts'
import type { DeploymentId, ProjectId } from '#shared/ids.ts'

const WORKERS = 4
const QUEUED = 500
const CHILD = join(import.meta.dirname, 'claimrace.child.ts')

function claimInChild(path: string, startAt: number): Promise<string> {
    return new Promise((resolve) => {
        let out = ''
        const child = spawn(process.execPath, [CHILD, path, String(startAt)])
        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8')
        })
        child.on('close', () => resolve(out.trim()))
    })
}

function wonIds(line: string): readonly DeploymentId[] {
    if (!line.startsWith('OK')) throw new Error(`child failed: ${line}`)

    const won: DeploymentId[] = []
    for (const field of line.slice(2).split(' ')) {
        if (field.length === 0) continue

        const id = parseDeploymentId(field)
        if (id === null) throw new Error(`child printed something that is not a deployment id: ${field}`)
        won.push(id)
    }
    return won
}

function insertOwningProject(db: DatabaseSync): ProjectId {
    const id = newProjectId()
    db.prepare(
        `INSERT INTO projects (id, name, repo_url, build_cmd, output_dir)
         VALUES (?, 'site', 'https://example.com/site.git', 'npm run build', 'dist')`,
    ).run(id)
    return id
}

function insertQueue(db: DatabaseSync, projectId: ProjectId, count: number): ReadonlySet<DeploymentId> {
    const queued = new Set<DeploymentId>()
    const insert = db.prepare('INSERT INTO deployments (id, project_id) VALUES (?, ?)')

    db.exec('BEGIN IMMEDIATE')
    for (let n = 0; n < count; n++) {
        const id = newDeploymentId()
        insert.run(id, projectId)
        queued.add(id)
    }
    db.exec('COMMIT')

    return queued
}

test('concurrent workers claim every queued deployment exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'berth-claimrace-'))
    try {
        const path = join(dir, 'berth.db')

        const db = openDatabase(path)
        const queued = insertQueue(db, insertOwningProject(db), QUEUED)
        db.close()
        assert.equal(queued.size, QUEUED)

        const startAt = Date.now() + 400
        const lines = await Promise.all(Array.from({ length: WORKERS }, () => claimInChild(path, startAt)))

        const won = lines.flatMap((line) => [...wonIds(line)])
        assert.equal(won.length, QUEUED, `expected ${QUEUED} claims in total, got ${won.length}`)
        assert.equal(new Set(won).size, QUEUED, 'a deployment was claimed by more than one worker')
        assert.deepEqual([...won].sort(), [...queued].sort())
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
