import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '#shared/db.ts'

const OPENERS = 8
const CHILD = join(import.meta.dirname, 'dbrace.child.ts')

function openInChild(path: string, startAt: number): Promise<string> {
    return new Promise((resolve) => {
        let out = ''
        const child = spawn(process.execPath, [CHILD, path, String(startAt)])
        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8')
        })
        child.on('close', () => resolve(out.trim()))
    })
}

test('openDatabase applies the schema and leaves the journal in WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'berth-db-'))
    try {
        const db = openDatabase(join(dir, 'berth.db'))
        assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal')
        assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
        assert.notEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = 'deployments'").get(), undefined)
        db.close()
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('every process opening one fresh database at once succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'berth-dbrace-'))
    try {
        const path = join(dir, 'berth.db')
        const startAt = Date.now() + 400
        const results = await Promise.all(
            Array.from({ length: OPENERS }, () => openInChild(path, startAt)),
        )
        assert.deepEqual(
            results,
            Array.from({ length: OPENERS }, () => 'ok'),
            `every opener should report ok, got: ${results.join(', ')}`,
        )
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
