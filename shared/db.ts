import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function openDatabase(path: string): DatabaseSync {
    mkdirSync(dirname(path), { recursive: true })

    const db = new DatabaseSync(path)
    // busy_timeout must be set before journal_mode: switching the journal takes an
    // exclusive lock, and with the default zero timeout a second opener fails outright.
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8'))

    return db
}
