import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '#shared/db.ts'
import { parseDeploymentId, parseProjectId } from '#shared/ids.ts'
import type { DeploymentId, ProjectId } from '#shared/ids.ts'
import type { RetentionPolicy } from '#shared/deployments.ts'
import { deleteUnreferencedDeployments } from '#shared/retention.ts'

const DAY_SECONDS = 86400

// Every seed timestamp derives from one instant, so the two 36-day-old rows land in the
// same second on purpose and the query's id tiebreak is the thing under test rather than
// whichever side of a second boundary the module happened to load on.
const SEEDED_AT = Date.now()

const POLICY: RetentionPolicy = { keepPerProject: 2, retentionDays: 14 }

function deploymentId(value: string): DeploymentId {
    const id = parseDeploymentId(value)
    if (id === null) assert.fail(`${value} is not a deployment id`)
    return id
}

function projectId(value: string): ProjectId {
    const id = parseProjectId(value)
    if (id === null) assert.fail(`${value} is not a project id`)
    return id
}

function secondsAgo(seconds: number): string {
    return `${new Date(SEEDED_AT - seconds * 1000).toISOString().slice(0, 19)}Z`
}

function daysAgo(days: number): string {
    return secondsAgo(days * DAY_SECONDS)
}

const ALPHA = projectId('prj_00000000000a')
const BETA = projectId('prj_00000000000b')
const GAMMA = projectId('prj_00000000000c')

type SeedCommon = {
    readonly id: DeploymentId
    readonly projectId: ProjectId
    readonly createdAt: string
    readonly isCollected: boolean
    readonly because: string
}

type Seed =
    | (SeedCommon & { readonly status: 'queued' })
    | (SeedCommon & { readonly status: 'building' })
    | (SeedCommon & { readonly status: 'ready'; readonly finishedAt: string })
    | (SeedCommon & { readonly status: 'failed'; readonly finishedAt: string })

const ALIASED = deploymentId('dpl_000000000001')
const TIED_OLDER = deploymentId('dpl_000000000005')
const TIED_NEWER = deploymentId('dpl_000000000006')

const SEEDS: readonly Seed[] = [
    {
        id: ALIASED,
        projectId: ALPHA,
        status: 'ready',
        createdAt: daysAgo(40),
        finishedAt: daysAgo(40),
        isCollected: false,
        because: 'an alias points at it',
    },
    {
        id: deploymentId('dpl_000000000002'),
        projectId: ALPHA,
        status: 'failed',
        createdAt: daysAgo(39),
        finishedAt: daysAgo(39),
        isCollected: true,
        because: 'failed is terminal, and five newer ready builds stand behind it',
    },
    {
        id: deploymentId('dpl_000000000003'),
        projectId: ALPHA,
        status: 'ready',
        createdAt: daysAgo(38),
        finishedAt: daysAgo(38),
        isCollected: true,
        because: 'four newer ready builds stand behind it',
    },
    {
        id: deploymentId('dpl_000000000004'),
        projectId: ALPHA,
        status: 'ready',
        createdAt: daysAgo(37),
        finishedAt: daysAgo(37),
        isCollected: true,
        because: 'three newer ready builds stand behind it',
    },
    {
        id: TIED_OLDER,
        projectId: ALPHA,
        status: 'ready',
        createdAt: daysAgo(36),
        finishedAt: daysAgo(36),
        isCollected: true,
        because: 'exactly keepPerProject newer ready builds, the id breaking the tie with the next',
    },
    {
        id: TIED_NEWER,
        projectId: ALPHA,
        status: 'ready',
        createdAt: daysAgo(36),
        finishedAt: daysAgo(36),
        isCollected: false,
        because: 'one short of keepPerProject newer ready builds',
    },
    {
        id: deploymentId('dpl_000000000007'),
        projectId: ALPHA,
        status: 'ready',
        createdAt: secondsAgo(30),
        finishedAt: secondsAgo(30),
        isCollected: false,
        because: 'it finished inside the retention window',
    },
    {
        id: deploymentId('dpl_000000000008'),
        projectId: ALPHA,
        status: 'building',
        createdAt: daysAgo(45),
        isCollected: false,
        because: 'a worker may be about to rename its directory into place, and only its status says so',
    },
    {
        id: deploymentId('dpl_000000000009'),
        projectId: ALPHA,
        status: 'queued',
        createdAt: daysAgo(44),
        isCollected: false,
        because: 'queued is work not yet done, and only its status says so',
    },
    {
        id: deploymentId('dpl_000000000011'),
        projectId: BETA,
        status: 'ready',
        createdAt: secondsAgo(20),
        finishedAt: secondsAgo(20),
        isCollected: false,
        because: 'two newer ready builds stand behind it, but it finished inside the retention window',
    },
    {
        id: deploymentId('dpl_000000000012'),
        projectId: BETA,
        status: 'ready',
        createdAt: secondsAgo(15),
        finishedAt: secondsAgo(15),
        isCollected: false,
        because: 'one newer ready build stands behind it',
    },
    {
        id: deploymentId('dpl_000000000013'),
        projectId: BETA,
        status: 'ready',
        createdAt: secondsAgo(10),
        finishedAt: secondsAgo(10),
        isCollected: false,
        because: 'it is the newest ready build of its project',
    },
    {
        id: deploymentId('dpl_000000000014'),
        projectId: BETA,
        status: 'ready',
        createdAt: daysAgo(40),
        finishedAt: daysAgo(40),
        isCollected: true,
        because: 'four newer ready builds stand behind it in its own project',
    },
    {
        id: deploymentId('dpl_000000000015'),
        projectId: BETA,
        status: 'ready',
        createdAt: daysAgo(40),
        finishedAt: secondsAgo(30),
        isCollected: false,
        because: 'it was created long ago but finished inside the retention window',
    },
    {
        id: deploymentId('dpl_000000000021'),
        projectId: GAMMA,
        status: 'ready',
        createdAt: daysAgo(40),
        finishedAt: daysAgo(40),
        isCollected: false,
        because: 'it is the only ready build of its project, and other projects do not count',
    },
    {
        id: deploymentId('dpl_000000000022'),
        projectId: GAMMA,
        status: 'failed',
        createdAt: daysAgo(39),
        finishedAt: daysAgo(39),
        isCollected: false,
        because: 'no ready build stands behind it, so it is the newest thing its project has',
    },
    {
        id: deploymentId('dpl_000000000023'),
        projectId: GAMMA,
        status: 'building',
        createdAt: daysAgo(38),
        isCollected: false,
        because: 'a build in flight is not something a ready build can be rolled back to',
    },
    {
        id: deploymentId('dpl_000000000024'),
        projectId: GAMMA,
        status: 'queued',
        createdAt: daysAgo(37),
        isCollected: false,
        because: 'a queued build is not something a ready build can be rolled back to',
    },
]

const LOGGED_COLLECTED = deploymentId('dpl_000000000003')

function insertProjects(db: DatabaseSync): void {
    const insert = db.prepare(
        `INSERT INTO projects (id, name, repo_url, build_cmd, output_dir)
         VALUES (?, ?, 'https://example.invalid/site.git', 'npm run build', 'dist')`,
    )
    for (const id of [ALPHA, BETA, GAMMA]) insert.run(id, id)
}

function insertSeed(db: DatabaseSync, seed: Seed): void {
    switch (seed.status) {
        case 'queued':
            db.prepare('INSERT INTO deployments (id, project_id, created_at) VALUES (?, ?, ?)').run(
                seed.id,
                seed.projectId,
                seed.createdAt,
            )
            return

        case 'building':
            db.prepare(
                `INSERT INTO deployments (id, project_id, status, created_at, started_at)
                 VALUES (?, ?, 'building', ?, ?)`,
            ).run(seed.id, seed.projectId, seed.createdAt, seed.createdAt)
            return

        case 'ready':
            db.prepare(
                `INSERT INTO deployments (id, project_id, status, created_at, started_at, finished_at)
                 VALUES (?, ?, 'ready', ?, ?, ?)`,
            ).run(seed.id, seed.projectId, seed.createdAt, seed.createdAt, seed.finishedAt)
            return

        case 'failed':
            db.prepare(
                `INSERT INTO deployments (id, project_id, status, created_at, started_at, finished_at, error)
                 VALUES (?, ?, 'failed', ?, ?, ?, 'build exited 1')`,
            ).run(seed.id, seed.projectId, seed.createdAt, seed.createdAt, seed.finishedAt)
            return
    }
}

function insertLogLine(db: DatabaseSync, id: DeploymentId, seq: number): void {
    db.prepare("INSERT INTO logs (deployment_id, seq, stream, line) VALUES (?, ?, 'stdout', 'building')").run(id, seq)
}

function withSeededDatabase(body: (db: DatabaseSync) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'berth-retention-'))
    try {
        const db = openDatabase(join(dir, 'berth.db'))
        try {
            insertProjects(db)
            for (const seed of SEEDS) insertSeed(db, seed)
            db.prepare("INSERT INTO aliases (hostname, deployment_id) VALUES ('site.localhost', ?)").run(ALIASED)
            insertLogLine(db, LOGGED_COLLECTED, 1)
            insertLogLine(db, LOGGED_COLLECTED, 2)
            insertLogLine(db, TIED_NEWER, 1)
            body(db)
        } finally {
            db.close()
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

function collectOrThrow(db: DatabaseSync, policy: RetentionPolicy): readonly DeploymentId[] {
    const collected = deleteUnreferencedDeployments(db, policy)
    if (!collected.ok) assert.fail(collected.error)
    return collected.value
}

function errorFrom(db: DatabaseSync, policy: RetentionPolicy): string {
    const collected = deleteUnreferencedDeployments(db, policy)
    if (collected.ok) assert.fail(`expected a refusal, got ${JSON.stringify(collected.value)}`)
    return collected.error
}

function sorted(ids: readonly DeploymentId[]): readonly string[] {
    return [...ids].sort()
}

function remainingIds(db: DatabaseSync): readonly string[] {
    return db
        .prepare('SELECT id FROM deployments ORDER BY id')
        .all()
        .map((row) => String(row.id))
}

function logLineCount(db: DatabaseSync, id: DeploymentId): number {
    return Number(db.prepare('SELECT count(*) AS lines FROM logs WHERE deployment_id = ?').get(id)?.lines)
}

function seedsWhere(isCollected: boolean): readonly Seed[] {
    return SEEDS.filter((seed) => seed.isCollected === isCollected)
}

test('collects exactly the deployments all four rules allow', () => {
    withSeededDatabase((db) => {
        const collected = collectOrThrow(db, POLICY)

        assert.deepEqual(sorted(collected), sorted(seedsWhere(true).map((seed) => seed.id)))

        for (const seed of seedsWhere(false)) {
            assert.ok(remainingIds(db).includes(seed.id), `${seed.id} should survive: ${seed.because}`)
        }
        for (const seed of seedsWhere(true)) {
            assert.ok(!remainingIds(db).includes(seed.id), `${seed.id} should be collected: ${seed.because}`)
        }

        assert.deepEqual(remainingIds(db), sorted(seedsWhere(false).map((seed) => seed.id)))
    })
})

test('reports exactly the rows it removed', () => {
    withSeededDatabase((db) => {
        const before = remainingIds(db)
        const collected = collectOrThrow(db, POLICY)
        const after = remainingIds(db)

        assert.deepEqual(sorted(collected), before.filter((id) => !after.includes(id)))
    })
})

test('a collected deployment takes its log rows with it', () => {
    withSeededDatabase((db) => {
        assert.equal(logLineCount(db, LOGGED_COLLECTED), 2)

        collectOrThrow(db, POLICY)

        assert.equal(logLineCount(db, LOGGED_COLLECTED), 0)
        assert.equal(logLineCount(db, TIED_NEWER), 1)
    })
})

test('leaves the alias pointing at the deployment it pointed at', () => {
    withSeededDatabase((db) => {
        collectOrThrow(db, POLICY)

        const alias = db.prepare('SELECT deployment_id FROM aliases WHERE hostname = ?').get('site.localhost')
        assert.equal(alias?.deployment_id, ALIASED)
    })
})

test('the foreign key refuses an aliased deployment independently of the query', () => {
    withSeededDatabase((db) => {
        assert.throws(
            () => db.prepare('DELETE FROM deployments WHERE id = ?').run(ALIASED),
            /FOREIGN KEY constraint failed/,
        )
    })
})

// The query names 'ready' and 'failed' and also requires a finished_at older than the
// window, and the schema makes those two the same condition: only a terminal row is
// allowed to carry a finished_at at all. Neither clause can be exercised without the
// other, so the schema half is asserted here rather than left as an assumption.
test('the schema refuses a finished_at on a row that has not finished', () => {
    withSeededDatabase((db) => {
        assert.throws(
            () =>
                db
                    .prepare(
                        `INSERT INTO deployments (id, project_id, status, created_at, started_at, finished_at)
                         VALUES ('dpl_00000000ffff', ?, 'building', ?, ?, ?)`,
                    )
                    .run(GAMMA, daysAgo(40), daysAgo(40), daysAgo(40)),
            /state_carries_only_its_own_fields/,
        )
    })
})

test('a second sweep collects nothing', () => {
    withSeededDatabase((db) => {
        collectOrThrow(db, POLICY)

        assert.deepEqual(collectOrThrow(db, POLICY), [])
    })
})

test('keeping none per project collects every terminal, unaliased, old deployment', () => {
    withSeededDatabase((db) => {
        const collected = collectOrThrow(db, { keepPerProject: 0, retentionDays: 14 })

        assert.deepEqual(sorted(collected), [
            'dpl_000000000002',
            'dpl_000000000003',
            'dpl_000000000004',
            'dpl_000000000005',
            'dpl_000000000006',
            'dpl_000000000014',
            'dpl_000000000021',
            'dpl_000000000022',
        ])
    })
})

test('refuses a policy that is not a pair of whole numbers, and deletes nothing', () => {
    withSeededDatabase((db) => {
        const before = remainingIds(db)

        assert.match(errorFrom(db, { keepPerProject: -1, retentionDays: 14 }), /keepPerProject/)
        assert.match(errorFrom(db, { keepPerProject: 1.5, retentionDays: 14 }), /keepPerProject/)
        assert.match(errorFrom(db, { keepPerProject: 2, retentionDays: -1 }), /retentionDays/)
        assert.match(errorFrom(db, { keepPerProject: 2, retentionDays: Number.NaN }), /retentionDays/)

        assert.deepEqual(remainingIds(db), before)
    })
})
