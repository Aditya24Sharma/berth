import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { newDeploymentId, parseDeploymentId, type DeploymentId } from '#shared/ids.ts'
import {
    berthDataDir,
    buildScratchDir,
    clonedRepoDir,
    databasePath,
    deploymentDir,
    deploymentsDir,
    trashDir,
    trashedDeploymentDir,
} from '#shared/paths.ts'

const ROOT = join(tmpdir(), 'berth-paths-test')

function isUnder(parent: string, path: string): boolean {
    const step = relative(parent, path)
    return step.length > 0 && !isAbsolute(step) && !step.split(sep).includes('..')
}

function withDataDir(dir: string | null, body: () => void): void {
    const previous = process.env.BERTH_DATA_DIR
    if (dir === null) delete process.env.BERTH_DATA_DIR
    else process.env.BERTH_DATA_DIR = dir
    try {
        body()
    } finally {
        if (previous === undefined) delete process.env.BERTH_DATA_DIR
        else process.env.BERTH_DATA_DIR = previous
    }
}

function everyPathFor(id: DeploymentId): ReadonlyArray<readonly [string, string]> {
    return [
        ['databasePath', databasePath()],
        ['deploymentsDir', deploymentsDir()],
        ['deploymentDir', deploymentDir(id)],
        ['buildScratchDir', buildScratchDir(id)],
        ['clonedRepoDir', clonedRepoDir(id)],
        ['trashDir', trashDir()],
        ['trashedDeploymentDir', trashedDeploymentDir(id)],
    ]
}

test('berthDataDir falls back to .berth in the home directory', () => {
    withDataDir(null, () => {
        assert.equal(berthDataDir(), join(homedir(), '.berth'))
    })
})

test('BERTH_DATA_DIR replaces the home directory default', () => {
    withDataDir(ROOT, () => {
        assert.equal(berthDataDir(), ROOT)
    })
})

test('every path lands under the data directory', () => {
    withDataDir(ROOT, () => {
        for (const [name, path] of everyPathFor(newDeploymentId())) {
            assert.ok(isUnder(ROOT, path), `${name}() escaped the data directory: ${path}`)
        }
    })
})

test('deployments, builds and trash are three distinct siblings', () => {
    withDataDir(ROOT, () => {
        const buildsDir = dirname(buildScratchDir(newDeploymentId()))
        const siblings = [deploymentsDir(), buildsDir, trashDir()]

        for (const sibling of siblings) {
            assert.equal(dirname(sibling), ROOT, `${sibling} is not a direct child of the root`)
        }
        assert.equal(new Set(siblings).size, siblings.length, `siblings collide: ${siblings.join(', ')}`)
    })
})

test('a deployment is published by renaming inside one directory', () => {
    withDataDir(ROOT, () => {
        const id = newDeploymentId()
        assert.equal(dirname(deploymentDir(id)), deploymentsDir())
        assert.equal(dirname(trashedDeploymentDir(id)), trashDir())
    })
})

test('clonedRepoDir is inside buildScratchDir', () => {
    withDataDir(ROOT, () => {
        const id = newDeploymentId()
        assert.ok(isUnder(buildScratchDir(id), clonedRepoDir(id)))
    })
})

test('two deployments never share a directory', () => {
    withDataDir(ROOT, () => {
        const first = newDeploymentId()
        const second = newDeploymentId()

        assert.notEqual(deploymentDir(first), deploymentDir(second))
        assert.notEqual(buildScratchDir(first), buildScratchDir(second))
        assert.notEqual(trashedDeploymentDir(first), trashedDeploymentDir(second))
    })
})

test('a traversal sequence is not a deployment id, so it never reaches a path', () => {
    for (const attempt of ['../../etc', 'dpl_../../etc', '/etc/passwd', 'dpl_0123456789ab/../..']) {
        assert.equal(parseDeploymentId(attempt), null, `${attempt} was accepted as a deployment id`)
    }
})
