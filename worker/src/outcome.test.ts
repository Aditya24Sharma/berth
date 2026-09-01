import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalStatusOf, type ContainerOutcome, type OutputCheck, type TerminalStatus } from './outcome.ts'

const OUTCOMES: readonly ContainerOutcome[] = [
    { kind: 'exited', code: 0 },
    { kind: 'exited', code: 1 },
    { kind: 'exited', code: 137 },
    { kind: 'timedOut', afterMs: 600000 },
    { kind: 'notStarted', reason: 'docker: command not found' },
]

const CHECKS: readonly OutputCheck[] = [
    { kind: 'present', path: '/data/builds/dpl_0123456789ab/repo/dist' },
    { kind: 'missing', expectedPath: '/data/builds/dpl_0123456789ab/repo/dist' },
    { kind: 'notADirectory', path: '/data/builds/dpl_0123456789ab/repo/dist' },
    { kind: 'isASymlink', path: '/data/builds/dpl_0123456789ab/repo/dist' },
    { kind: 'escapesRepo', outputDir: '../..' },
]

function errorFrom(status: TerminalStatus): string {
    if (status.status === 'ready') assert.fail('expected a failed status, got ready')
    return status.error
}

function statusFrom(outcome: ContainerOutcome, check: OutputCheck): TerminalStatus {
    return terminalStatusOf(outcome, () => check)
}

test('a clean exit with output present is ready', () => {
    assert.deepEqual(statusFrom({ kind: 'exited', code: 0 }, { kind: 'present', path: '/repo/dist' }), {
        status: 'ready',
    })
})

test('exactly one cell of the truth table is ready', () => {
    const ready: string[] = []

    for (const outcome of OUTCOMES) {
        for (const check of CHECKS) {
            if (statusFrom(outcome, check).status === 'ready') ready.push(`${outcome.kind}/${check.kind}`)
        }
    }

    assert.deepEqual(ready, ['exited/present'])
})

test('every cell that is not ready carries an error naming the problem', () => {
    for (const outcome of OUTCOMES) {
        for (const check of CHECKS) {
            const status = statusFrom(outcome, check)
            if (status.status === 'ready') continue
            assert.notEqual(status.error.length, 0, `${outcome.kind}/${check.kind} failed with an empty error`)
        }
    }
})

test('the output is never inspected unless the container exited cleanly', () => {
    for (const outcome of OUTCOMES) {
        if (outcome.kind === 'exited' && outcome.code === 0) continue

        let inspections = 0
        const status = terminalStatusOf(outcome, () => {
            inspections += 1
            return { kind: 'present', path: '/repo/dist' }
        })

        assert.equal(inspections, 0, `${outcome.kind} inspected the output of a build that did not succeed`)
        assert.equal(status.status, 'failed')
    }
})

test('a clean exit with no output directory names the path that was expected', () => {
    const status = statusFrom(
        { kind: 'exited', code: 0 },
        { kind: 'missing', expectedPath: '/data/builds/dpl_0123456789ab/repo/dist' },
    )

    assert.equal(errorFrom(status), 'the build produced no output directory at /data/builds/dpl_0123456789ab/repo/dist')
})

test('a clean exit with the wrong kind of output says which wrong kind', () => {
    assert.equal(
        errorFrom(statusFrom({ kind: 'exited', code: 0 }, { kind: 'notADirectory', path: '/repo/dist' })),
        'the build output /repo/dist is not a directory',
    )
    assert.equal(
        errorFrom(statusFrom({ kind: 'exited', code: 0 }, { kind: 'isASymlink', path: '/repo/dist' })),
        'the build output /repo/dist is a symlink',
    )
    assert.equal(
        errorFrom(statusFrom({ kind: 'exited', code: 0 }, { kind: 'escapesRepo', outputDir: '../..' })),
        'the output directory ../.. resolves outside the repository',
    )
})

test('a non-zero exit names the exit code', () => {
    assert.equal(
        errorFrom(statusFrom({ kind: 'exited', code: 1 }, { kind: 'present', path: '/repo/dist' })),
        'the build exited with code 1',
    )
    assert.equal(
        errorFrom(statusFrom({ kind: 'exited', code: 137 }, { kind: 'present', path: '/repo/dist' })),
        'the build exited with code 137',
    )
})

test('a timeout names the elapsed time in seconds and never an exit code', () => {
    const error = errorFrom(statusFrom({ kind: 'timedOut', afterMs: 600000 }, { kind: 'present', path: '/repo/dist' }))

    assert.equal(error, 'the build timed out after 600 seconds')
    assert.equal(error.includes('137'), false)
    assert.equal(error.includes('exit'), false)
})

test('a container that never started reports its reason', () => {
    const notStarted: ContainerOutcome = { kind: 'notStarted', reason: 'docker: command not found' }

    assert.equal(
        errorFrom(statusFrom(notStarted, { kind: 'present', path: '/repo/dist' })),
        'the build container did not start: docker: command not found',
    )
})
