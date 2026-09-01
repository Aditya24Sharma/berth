import { openDatabase } from '#shared/db.ts'
import { claimQueuedDeployment } from '#shared/deployments.ts'

const [path, startAtRaw] = process.argv.slice(2)
if (path === undefined || startAtRaw === undefined) {
    console.log('ERR usage: claimrace.child.ts <path> <startAtEpochMs>')
    process.exit(1)
}

try {
    const db = openDatabase(path)

    // Spin after the open, not before it: opening costs enough that a pre-open spin
    // lets the quickest sibling drain the queue before the others reach a claim.
    while (Date.now() < Number(startAtRaw)) { /* spin to a start instant shared with the siblings */ }

    const won: string[] = []
    for (;;) {
        const claim = claimQueuedDeployment(db)
        if (claim === null) break
        if (!claim.ok) {
            console.log(`ERR ${claim.error}`)
            process.exit(1)
        }
        won.push(claim.value.id)
    }

    db.close()
    console.log(`OK ${won.join(' ')}`)
} catch (cause) {
    console.log(`ERR ${cause instanceof Error ? cause.message : String(cause)}`)
}
