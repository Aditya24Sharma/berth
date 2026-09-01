export type ContainerOutcome =
    | { readonly kind: 'exited'; readonly code: number }
    | { readonly kind: 'timedOut'; readonly afterMs: number }
    | { readonly kind: 'notStarted'; readonly reason: string }

export type OutputCheck =
    | { readonly kind: 'present'; readonly path: string }
    | { readonly kind: 'missing'; readonly expectedPath: string }
    | { readonly kind: 'notADirectory'; readonly path: string }
    | { readonly kind: 'isASymlink'; readonly path: string }
    | { readonly kind: 'escapesRepo'; readonly outputDir: string }

export type TerminalStatus =
    | { readonly status: 'ready' }
    | { readonly status: 'failed'; readonly error: string }

function failed(error: string): TerminalStatus {
    return { status: 'failed', error }
}

function terminalStatusOfOutput(check: OutputCheck): TerminalStatus {
    switch (check.kind) {
        case 'present':
            return { status: 'ready' }
        case 'missing':
            return failed(`the build produced no output directory at ${check.expectedPath}`)
        case 'notADirectory':
            return failed(`the build output ${check.path} is not a directory`)
        case 'isASymlink':
            return failed(`the build output ${check.path} is a symlink`)
        case 'escapesRepo':
            return failed(`the output directory ${check.outputDir} resolves outside the repository`)
    }
}

export function terminalStatusOf(outcome: ContainerOutcome, inspectOutput: () => OutputCheck): TerminalStatus {
    // A timeout and a memory kill both exit 137, so the message names elapsed time rather
    // than the exit code the container reported.
    if (outcome.kind === 'timedOut') {
        return failed(`the build timed out after ${Math.round(outcome.afterMs / 1000)} seconds`)
    }
    if (outcome.kind === 'notStarted') return failed(`the build container did not start: ${outcome.reason}`)
    if (outcome.code !== 0) return failed(`the build exited with code ${outcome.code}`)
    return terminalStatusOfOutput(inspectOutput())
}
