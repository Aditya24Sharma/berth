# berth — working agreement

Read `README.md` for what berth is and `docs/architecture.html` for how it fits
together. This file is about how code gets written here.

One idea underneath all of it: **the code must not be able to lie.** A type that
overstates what it knows, a name that promises something the function doesn't
do, and a comment that contradicts the line below it are the same failure. Each
one costs a reader trust, and once a reader stops trusting the code they have to
run it in their head to learn anything.

---

## 1. Types tell the truth

A type is a claim about what a value can be. If the claim is wider than reality,
the compiler stops helping. If it's narrower, you'll paper over it with a cast
and end up lying in a harder-to-find way.

### TypeScript

**`any` and `unknown` are not allowed.** Not in signatures, not in generics, not
as a temporary step. If you can't name the type, you don't yet understand the
value, and that's the actual problem to solve.

Data arriving from outside the program — an HTTP body, a config file, a database
row — is the usual excuse for both. It isn't one. Validate at the boundary and
return a real type. Everything past that point is honestly typed:

```ts
// lying — the cast asserts a shape nobody checked
const body = (await req.json()) as CreateDeploymentBody

// truthful — the shape is verified, and failure is a value the caller must handle
const body = parseCreateDeploymentBody(await req.text())
if (!body.ok) return badRequest(body.error)
```

**Make impossible states unrepresentable.** A pile of optional fields says "any
combination of these can happen," which is almost never true. When fields only
exist in certain states, say so:

```ts
// lying — permits { status: 'ready' } with no output, and 'banana' as a status
type Deployment = { status: string; outputDir?: string; error?: string }

// truthful — each state carries exactly what that state has
type Deployment =
  | { status: 'queued' }
  | { status: 'building'; startedAt: Date }
  | { status: 'ready'; outputDir: string }
  | { status: 'failed'; error: string }
```

Also banned, for the same reason: `as` casts between unrelated types, the
non-null assertion `!`, and `@ts-ignore`. If you reach for one, the type is
wrong — fix the type. `as const` and casts that genuinely narrow a validated
value are fine.

Prefer distinct types over bare strings for identifiers. `DeploymentId` and
`Hostname` are both strings, and passing one where the other belongs is a bug
the compiler should catch.

### Go

**No `any` / `interface{}`, and no `map[string]interface{}`.** Same rule, same
reason. Define the struct.

Give identifiers named types rather than passing `string` everywhere:

```go
type DeploymentID string
type Hostname     string

func Resolve(h Hostname) (DeploymentID, error)  // can't be called with the wrong string
```

**Never discard an error with `_`.** An ignored error is a claim that the
operation cannot fail, and it's almost always false. Handle it or wrap it with
enough context to locate it:

```go
data, err := os.ReadFile(path)
if err != nil {
    return fmt.Errorf("read deployment manifest %s: %w", path, err)
}
```

`panic` is for programmer errors that make continuing meaningless, not for
runtime conditions. A missing deployment is an error value, not a panic.

---

## 2. Names are contracts

A name is a promise about behaviour. Breaking it is worse than a vague name,
because a vague name makes a reader look while a wrong name makes them not
bother.

- **The name must match what the thing actually does.** If a function called
  `validateAndSave` no longer validates, one of the two has to change. Renaming
  is not cosmetic work.
- **Name what it is, not what you plan for it.** `VersionedStructuredRequestWithOptions`
  carrying unversioned requests is a lie with extra syllables. Call it
  `DeployRequest` and let it grow a real name when it grows real behaviour.
- **No filler.** `Manager`, `Helper`, `Util`, `Data`, `Info`, `Service`, `handle`
  and `process` carry no information. If a type genuinely has no describable
  responsibility, that's a design problem the name is reporting to you.
- **Booleans read as assertions:** `isReady`, `hasAlias`, `canRollback`. Not
  `ready` (a value?), not `status` (which one?).
- **Say when something mutates or costs.** `loadDeployment` reads from disk;
  `deployment` doesn't. A reader should be able to guess the cost from the name.

The test: someone opening this file in six months, with no context, should be
able to predict what a thing does from its name and be right.

---

## 3. Comments explain why, never what

**Default to none.** If code needs a comment to be understood, the code is
wrong. Fix the code — extract the confusing part into a well-named function,
split the overloaded one, name the mystery constant. A comment that narrates
what the line below does is a bug report that was answered with a sticky note.

```ts
// no — narrates the code
// increment the sequence number
seq++

// no — announces an edit, and is stale the moment it's true
// new: added rollback support here

// yes — records a constraint you cannot infer from the code
// SQLite serialises writers; log lines batch so a noisy build cannot
// starve the status update that ends it.
```

**Never comment a new addition.** A new theme token, a new database column, a
new enum member, a new config key — the name is the documentation. If
`output_dir` needs a comment saying it's the output directory, delete the
comment; if it needs one saying something else, the name is wrong.

```sql
-- no
output_dir TEXT NOT NULL,  -- directory the build writes into

-- yes
output_dir TEXT NOT NULL,
```

Legitimate comments are rare and specific: an external system's quirk, a
non-obvious performance or correctness constraint, a deliberate tradeoff and
what would change it, or a link to the issue explaining a workaround. Write them
for the reader who is about to change the code and doesn't know why they
shouldn't.

Delete commented-out code. Git remembers.

---

## 4. Commits

**Subject line only. No body, ever.** If a change needs paragraphs of
explanation, it's too big — split it.

- Imperative, scoped, under 72 characters: `feat(proxy): resolve aliases from the database`
- One logical change per commit. Refactor and behaviour change are two commits.
- No AI co-author trailer, and don't change the configured git user.

---

## 5. Invariants specific to berth

These are the load-bearing assumptions. Code that breaks one is wrong even if it
passes its tests.

- **A deployment directory is written once and never modified.** Rebuilding
  means a new deployment id. Nothing edits, patches, or cleans a deployment in
  place.
- **Rollback and promotion only move an alias.** If a code path makes them touch
  a file or trigger a build, that path is wrong.
- **An alias always points at a real deployment.** Updating one is a single
  atomic write; there is no moment where a hostname resolves to nothing.
- **Builds only ever run inside a container**, with a memory limit, a CPU limit
  and a timeout. A build is untrusted code from the internet.
- **Deployment status only moves along the state machine:** `queued → building →
  ready | failed`. Terminal states are terminal.
- **Runtime state is never committed.** The SQLite database and the deployments
  store live outside the repo and are created by the program, not by a human.
