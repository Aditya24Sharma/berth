import test from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { insertQueuedDeployment, parseDeploymentRow } from './deployments.ts'
import { newDeploymentId, newProjectId } from '#shared/ids.ts'
import type { JsonValue } from '#shared/json.ts'
import { insertProject, parseCreateProjectBody, parseProjectRow } from './projects.ts'

const VALID_BODY: JsonValue = {
    name: 'blog',
    repoUrl: 'https://github.com/octocat/blog',
    buildCmd: 'npm run build',
    outputDir: 'dist',
}

function seededDatabase(): DatabaseSync {
    return openDatabase(':memory:')
}

function onlyRow(db: DatabaseSync, sql: string): Record<string, SQLOutputValue> {
    const row = db.prepare(sql).get()
    assert.ok(row !== undefined, `expected a row from: ${sql}`)
    return row
}

test('parseCreateProjectBody accepts a complete body', () => {
    const result = parseCreateProjectBody(VALID_BODY)
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.deepEqual(result.value, {
        name: 'blog',
        repoUrl: 'https://github.com/octocat/blog',
        buildCmd: 'npm run build',
        outputDir: 'dist',
    })
})

test('parseCreateProjectBody rejects a missing field', () => {
    const { name, ...withoutName } = VALID_BODY as Record<string, JsonValue>
    assert.equal(parseCreateProjectBody(withoutName).ok, false)
})

test('parseCreateProjectBody rejects a field of the wrong type', () => {
    assert.equal(parseCreateProjectBody({ ...VALID_BODY, name: 42 }).ok, false)
})

test('parseCreateProjectBody rejects an empty string', () => {
    assert.equal(parseCreateProjectBody({ ...VALID_BODY, outputDir: '' }).ok, false)
})

test('parseCreateProjectBody rejects a body that is not an object', () => {
    for (const body of [null, 'blog', 7, true, ['blog']] as const) {
        assert.equal(parseCreateProjectBody(body).ok, false, `should reject ${JSON.stringify(body)}`)
    }
})

test('parseProjectRow reads back what insertProject wrote', () => {
    const db = seededDatabase()
    const id = newProjectId()
    insertProject(db, id, {
        name: 'blog',
        repoUrl: 'https://github.com/octocat/blog',
        buildCmd: 'npm run build',
        outputDir: 'dist',
    })

    const result = parseProjectRow(onlyRow(db, 'SELECT * FROM projects'))
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.equal(result.value.id, id)
    assert.equal(result.value.name, 'blog')
    assert.equal(result.value.outputDir, 'dist')
    assert.match(result.value.createdAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('parseProjectRow rejects a row with a missing column', () => {
    assert.equal(parseProjectRow({ id: 'prj_0123456789ab', name: 'blog' }).ok, false)
})

test('parseProjectRow rejects a row whose id is not a project id', () => {
    const row = { id: 'dpl_0123456789ab', name: 'b', repo_url: 'r', build_cmd: 'c', output_dir: 'd', created_at: '2026-01-01T00:00:00Z' }
    assert.equal(parseProjectRow(row).ok, false)
})

test('parseDeploymentRow reads a freshly queued deployment', () => {
    const db = seededDatabase()
    const projectId = newProjectId()
    insertProject(db, projectId, { name: 'b', repoUrl: 'r', buildCmd: 'c', outputDir: 'd' })
    const id = newDeploymentId()
    insertQueuedDeployment(db, id, projectId)

    const result = parseDeploymentRow(onlyRow(db, 'SELECT * FROM deployments'))
    assert.ok(result.ok, result.ok ? '' : result.error)
    assert.equal(result.value.status, 'queued')
    assert.equal(result.value.id, id)
    assert.equal(result.value.projectId, projectId)
    assert.equal(result.value.commitSha, null)
})

test('parseDeploymentRow carries the fields each state owns', () => {
    const at = '2026-01-01T00:00:00Z'
    const common = { id: 'dpl_0123456789ab', project_id: 'prj_0123456789ab', commit_sha: null, created_at: at }

    const building = parseDeploymentRow({ ...common, status: 'building', started_at: at, finished_at: null, error: null })
    assert.ok(building.ok, building.ok ? '' : building.error)
    assert.equal(building.value.status === 'building' && building.value.startedAt, at)

    const failed = parseDeploymentRow({ ...common, status: 'failed', started_at: at, finished_at: at, error: 'exit 1' })
    assert.ok(failed.ok, failed.ok ? '' : failed.error)
    assert.equal(failed.value.status === 'failed' && failed.value.error, 'exit 1')
})

test('parseDeploymentRow rejects a status outside the state machine', () => {
    const at = '2026-01-01T00:00:00Z'
    const row = { id: 'dpl_0123456789ab', project_id: 'prj_0123456789ab', commit_sha: null, created_at: at, status: 'in_progress', started_at: null, finished_at: null, error: null }
    assert.equal(parseDeploymentRow(row).ok, false)
})

test('parseDeploymentRow rejects a state missing the fields it must have', () => {
    const at = '2026-01-01T00:00:00Z'
    const row = { id: 'dpl_0123456789ab', project_id: 'prj_0123456789ab', commit_sha: null, created_at: at, status: 'ready', started_at: at, finished_at: null, error: null }
    assert.equal(parseDeploymentRow(row).ok, false)
})
