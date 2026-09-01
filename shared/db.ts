import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const BUSY_TIMEOUT_MS = 5000

function journalMode(db: DatabaseSync): string {
    const mode = db.prepare('PRAGMA journal_mode').get()?.journal_mode
    return typeof mode === 'string' ? mode : ''
}

// Switching into WAL takes a brief exclusive lock that busy_timeout does not cover, so
// openers of a fresh database race and all but one fail outright. WAL is recorded in the
// file header, so a loser only has to wait for the winner and read the mode back.
function useWriteAheadLog(db: DatabaseSync, deadline: number): void {
    for (;;) {
        if (journalMode(db) === 'wal') return
        try {
            db.exec('PRAGMA journal_mode = WAL')
            return
        } catch (cause) {
            if (Date.now() >= deadline) throw cause
        }
    }
}

export function openDatabase(path: string): DatabaseSync {
    mkdirSync(dirname(path), { recursive: true })

    const db = new DatabaseSync(path)
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    useWriteAheadLog(db, Date.now() + BUSY_TIMEOUT_MS)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(readFileSync(join(import.meta.dirname, 'schema.sql'), 'utf8'))

    return db
}
