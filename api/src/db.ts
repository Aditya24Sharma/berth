import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function berthDataDir(): string {
    return process.env.BERTH_DATA_DIR ?? join(homedir(), '.berth')
}

export function defaultDatabasePath(): string {
    return join(berthDataDir(), 'berth.db')
}

export function openDatabase(path: string = defaultDatabasePath()): DatabaseSync {
    mkdirSync(dirname(path), { recursive: true })

    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8'))

    return db
}
