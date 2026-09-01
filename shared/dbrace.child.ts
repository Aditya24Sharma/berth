import { openDatabase } from '#shared/db.ts'

const [path, startAtRaw] = process.argv.slice(2)
if (path === undefined || startAtRaw === undefined) {
    console.log('ERR usage: dbrace.child.ts <path> <startAtEpochMs>')
    process.exit(1)
}

while (Date.now() < Number(startAtRaw)) { /* spin to a start instant shared with the siblings */ }

try {
    const db = openDatabase(path)
    const mode = db.prepare('PRAGMA journal_mode').get()?.journal_mode
    db.close()
    console.log(mode === 'wal' ? 'ok' : `ERR journal_mode is ${String(mode)}`)
} catch (cause) {
    console.log(`ERR ${cause instanceof Error ? cause.message : String(cause)}`)
}
