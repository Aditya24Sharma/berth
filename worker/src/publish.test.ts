import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { newDeploymentId, type DeploymentId } from '#shared/ids.ts'
import { buildScratchDir, clonedRepoDir, deploymentDir, trashDir, trashedDeploymentDir } from '#shared/paths.ts'
import type { OutputCheck } from './outcome.ts'
import {
    buildOutputPathWithin,
    clearTrash,
    discardBuildScratch,
    inspectBuildOutput,
    publishBuildOutput,
    trashDeploymentDirectory,
} from './publish.ts'

const DATA_DIR = mkdtempSync(join(tmpdir(), 'berth-publish-'))
const OUTSIDE_DIR = mkdtempSync(join(tmpdir(), 'berth-outside-'))

process.env.BERTH_DATA_DIR = DATA_DIR

test.after(() => {
    rmSync(DATA_DIR, { recursive: true, force: true })
    rmSync(OUTSIDE_DIR, { recursive: true, force: true })
})

function cloneWithOutput(id: DeploymentId, outputDir: string): string {
    const repoDir = clonedRepoDir(id)
    mkdirSync(join(repoDir, outputDir), { recursive: true })
    writeFileSync(join(repoDir, outputDir, 'index.html'), `<h1>${id}</h1>`)
    return repoDir
}

function emptyClone(id: DeploymentId): string {
    const repoDir = clonedRepoDir(id)
    mkdirSync(repoDir, { recursive: true })
    return repoDir
}

function pathFrom(check: OutputCheck): string {
    if (check.kind !== 'present') assert.fail(`expected present, got ${check.kind}`)
    return check.path
}

function publishedPathFor(id: DeploymentId, outputPath: string): string {
    const published = publishBuildOutput(id, outputPath)
    if (!published.ok) assert.fail(`expected a publish, got ${published.error}`)
    return published.value
}

test('buildOutputPathWithin resolves a relative output directory inside the clone', () => {
    const repoDir = '/data/builds/dpl_0123456789ab/repo'

    assert.equal(buildOutputPathWithin(repoDir, 'dist'), `${repoDir}/dist`)
    assert.equal(buildOutputPathWithin(repoDir, 'build/static'), `${repoDir}/build/static`)
    assert.equal(buildOutputPathWithin(repoDir, './dist/'), `${repoDir}/dist`)
})

test('buildOutputPathWithin rejects every output directory that is not inside the clone', () => {
    const repoDir = '/data/builds/dpl_0123456789ab/repo'

    for (const outputDir of ['..', '../..', '/etc', 'dist/../../..', '', '.', '../repo-other']) {
        assert.equal(
            buildOutputPathWithin(repoDir, outputDir),
            null,
            `${JSON.stringify(outputDir)} was accepted as an output directory`,
        )
    }
})

test('buildOutputPathWithin touches no filesystem', () => {
    const absent = join(OUTSIDE_DIR, 'no-such-clone')

    assert.equal(existsSync(absent), false)
    assert.equal(buildOutputPathWithin(absent, 'dist'), join(absent, 'dist'))
})

test('inspectBuildOutput finds a real output directory', () => {
    const id = newDeploymentId()
    const repoDir = cloneWithOutput(id, 'dist')

    assert.deepEqual(inspectBuildOutput(repoDir, 'dist'), { kind: 'present', path: join(repoDir, 'dist') })
})

test('inspectBuildOutput reports an output directory the build never wrote', () => {
    const id = newDeploymentId()
    const repoDir = emptyClone(id)

    assert.deepEqual(inspectBuildOutput(repoDir, 'dist'), { kind: 'missing', expectedPath: join(repoDir, 'dist') })
})

test('inspectBuildOutput reports a file where a directory was expected', () => {
    const id = newDeploymentId()
    const repoDir = emptyClone(id)
    writeFileSync(join(repoDir, 'dist'), 'not a directory')

    assert.deepEqual(inspectBuildOutput(repoDir, 'dist'), { kind: 'notADirectory', path: join(repoDir, 'dist') })
})

test('inspectBuildOutput reports a file standing in for a parent of the output directory', () => {
    const id = newDeploymentId()
    const repoDir = emptyClone(id)
    writeFileSync(join(repoDir, 'build'), 'not a directory')

    assert.deepEqual(inspectBuildOutput(repoDir, 'build/static'), {
        kind: 'notADirectory',
        path: join(repoDir, 'build', 'static'),
    })
})

test('inspectBuildOutput refuses a symlinked output directory before following it', () => {
    const id = newDeploymentId()
    const repoDir = emptyClone(id)
    const secrets = join(OUTSIDE_DIR, 'secrets')
    mkdirSync(secrets, { recursive: true })
    writeFileSync(join(secrets, 'id_rsa'), 'a private key')
    symlinkSync(secrets, join(repoDir, 'dist'), 'dir')

    assert.deepEqual(inspectBuildOutput(repoDir, 'dist'), { kind: 'isASymlink', path: join(repoDir, 'dist') })
})

test('inspectBuildOutput reports an output directory that escapes the clone', () => {
    const id = newDeploymentId()
    const repoDir = emptyClone(id)

    assert.deepEqual(inspectBuildOutput(repoDir, '../..'), { kind: 'escapesRepo', outputDir: '../..' })
    assert.deepEqual(inspectBuildOutput(repoDir, OUTSIDE_DIR), { kind: 'escapesRepo', outputDir: OUTSIDE_DIR })
})

test('publishBuildOutput moves the output into the store and returns the deployment directory', () => {
    const id = newDeploymentId()
    const repoDir = cloneWithOutput(id, 'dist')
    const outputPath = pathFrom(inspectBuildOutput(repoDir, 'dist'))

    const published = publishedPathFor(id, outputPath)

    assert.equal(published, deploymentDir(id))
    assert.equal(readFileSync(join(published, 'index.html'), 'utf8'), `<h1>${id}</h1>`)
    assert.equal(existsSync(outputPath), false)
})

test('a deployment directory is written once: a second publish fails and clobbers nothing', () => {
    const id = newDeploymentId()
    const first = cloneWithOutput(id, 'dist')
    publishedPathFor(id, pathFrom(inspectBuildOutput(first, 'dist')))

    const rebuild = clonedRepoDir(newDeploymentId())
    mkdirSync(join(rebuild, 'dist'), { recursive: true })
    writeFileSync(join(rebuild, 'dist', 'index.html'), 'a rebuild that must not land')

    const second = publishBuildOutput(id, join(rebuild, 'dist'))

    assert.equal(second.ok, false)
    assert.equal(readFileSync(join(deploymentDir(id), 'index.html'), 'utf8'), `<h1>${id}</h1>`)
    assert.equal(existsSync(join(rebuild, 'dist', 'index.html')), true)
})

test('a second publish over an empty deployment directory still fails', () => {
    const id = newDeploymentId()
    mkdirSync(deploymentDir(id), { recursive: true })
    const repoDir = cloneWithOutput(id, 'dist')

    const published = publishBuildOutput(id, join(repoDir, 'dist'))

    assert.equal(published.ok, false)
})

test('publishBuildOutput returns the failure rather than throwing when the output is gone', () => {
    const id = newDeploymentId()
    const published = publishBuildOutput(id, join(clonedRepoDir(id), 'dist'))

    assert.equal(published.ok, false)
    assert.equal(existsSync(deploymentDir(id)), false)
})

test('discardBuildScratch removes the clone and is safe when it has already gone', () => {
    const id = newDeploymentId()
    cloneWithOutput(id, 'dist')
    assert.equal(existsSync(buildScratchDir(id)), true)

    discardBuildScratch(id)
    assert.equal(existsSync(buildScratchDir(id)), false)

    discardBuildScratch(id)
    assert.equal(existsSync(buildScratchDir(id)), false)
})

test('trashDeploymentDirectory makes the deployment vanish from the store in one rename', () => {
    const id = newDeploymentId()
    const repoDir = cloneWithOutput(id, 'dist')
    publishedPathFor(id, join(repoDir, 'dist'))

    const trashed = trashDeploymentDirectory(id)

    assert.equal(trashed.ok, true)
    assert.equal(existsSync(deploymentDir(id)), false)
    assert.equal(readFileSync(join(trashedDeploymentDir(id), 'index.html'), 'utf8'), `<h1>${id}</h1>`)
})

test('trashDeploymentDirectory reports a deployment that is not in the store', () => {
    assert.equal(trashDeploymentDirectory(newDeploymentId()).ok, false)
})

test('clearTrash empties the trash and leaves the deployments store alone', () => {
    const kept = newDeploymentId()
    const collected = newDeploymentId()
    publishedPathFor(kept, join(cloneWithOutput(kept, 'dist'), 'dist'))
    publishedPathFor(collected, join(cloneWithOutput(collected, 'dist'), 'dist'))
    assert.equal(trashDeploymentDirectory(collected).ok, true)

    clearTrash()

    assert.equal(existsSync(trashedDeploymentDir(collected)), false)
    assert.equal(existsSync(join(deploymentDir(kept), 'index.html')), true)
})

test('clearTrash is safe when the trash has never been created', () => {
    clearTrash()
    clearTrash()

    assert.equal(existsSync(trashDir()), false)
})

test('every path this module writes stays under BERTH_DATA_DIR', () => {
    const id = newDeploymentId()

    for (const path of [deploymentDir(id), trashedDeploymentDir(id), buildScratchDir(id)]) {
        assert.ok(path.startsWith(resolve(DATA_DIR)), `${path} escaped the data directory`)
    }
})
