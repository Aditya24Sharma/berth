import { lstatSync, mkdirSync, renameSync, rmSync, type Stats } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type { DeploymentId } from '#shared/ids.ts'
import { invalid, valid, type Parsed } from '#shared/json.ts'
import { buildScratchDir, deploymentDir, deploymentsDir, trashDir, trashedDeploymentDir } from '#shared/paths.ts'
import type { OutputCheck } from './outcome.ts'

function errnoOf(error: Error): string | null {
    return 'code' in error && typeof error.code === 'string' ? error.code : null
}

export function buildOutputPathWithin(repoDir: string, outputDir: string): string | null {
    if (outputDir.length === 0) return null
    if (isAbsolute(outputDir)) return null

    const root = resolve(repoDir)
    const path = resolve(root, outputDir)
    return path.startsWith(root + sep) ? path : null
}

export function inspectBuildOutput(repoDir: string, outputDir: string): OutputCheck {
    const path = buildOutputPathWithin(repoDir, outputDir)
    if (path === null) return { kind: 'escapesRepo', outputDir }

    let entry: Stats | undefined
    try {
        // lstat, not stat: the build writes this path, so `dist` can be a symlink to
        // anywhere on the host and stat would report the kind of whatever it points at.
        entry = lstatSync(path, { throwIfNoEntry: false })
    } catch (error) {
        if (!(error instanceof Error) || errnoOf(error) !== 'ENOTDIR') throw error
        return { kind: 'notADirectory', path }
    }

    if (entry === undefined) return { kind: 'missing', expectedPath: path }
    if (entry.isSymbolicLink()) return { kind: 'isASymlink', path }
    if (!entry.isDirectory()) return { kind: 'notADirectory', path }
    return { kind: 'present', path }
}

export function publishBuildOutput(id: DeploymentId, outputPath: string): Parsed<string> {
    const target = deploymentDir(id)

    try {
        if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
            return invalid('a deployment directory already exists for this id')
        }
        mkdirSync(deploymentsDir(), { recursive: true })
        // rename(2) is atomic only within one filesystem: a cross-device move fails with
        // EXDEV and the fallback is a copy, which has the half-written window this design
        // exists to avoid. Builds and deployments share BERTH_DATA_DIR so that
        // same-filesystem is structural rather than a coincidence of one host's layout.
        renameSync(outputPath, target)
    } catch (error) {
        if (!(error instanceof Error)) throw error
        return invalid(`could not publish the build output to ${target}: ${error.message}`)
    }

    return valid(target)
}

export function discardBuildScratch(id: DeploymentId): void {
    rmSync(buildScratchDir(id), { recursive: true, force: true })
}

export function trashDeploymentDirectory(id: DeploymentId): Parsed<null> {
    const source = deploymentDir(id)

    try {
        mkdirSync(trashDir(), { recursive: true })
        renameSync(source, trashedDeploymentDir(id))
    } catch (error) {
        if (!(error instanceof Error)) throw error
        return invalid(`could not move ${source} to the trash: ${error.message}`)
    }

    return valid(null)
}

export function clearTrash(): void {
    rmSync(trashDir(), { recursive: true, force: true })
}
