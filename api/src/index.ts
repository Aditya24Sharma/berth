import { defaultDatabasePath, openDatabase } from './db.ts'

const db = openDatabase()
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()

console.log(`berth api — database at ${defaultDatabasePath()}`)
console.log(tables.map((t) => t['name']).join(', '))
