# berth

A small deployment platform, built from scratch. Give it a Git repository; it
builds the site and serves it at its own URL.

Named for the slot a ship is assigned to dock in: every deployment gets its own
berth and keeps it, and a name simply points at whichever berth is currently
live.

> **Status:** in development. Nothing works yet — see the milestones below.

## What it does

Turns a commit into a URL that serves files, and remembers every one it has
ever made so you can go back to any of them instantly.

- Build a repo in a sandboxed container
- Store the output under an immutable deployment id
- Serve it at `<deployment-id>.localhost`
- Point a friendly name at any deployment: `myapp.localhost`
- Roll back by moving that pointer — no rebuild, nothing deleted

## Design

Three programs that never call each other. They coordinate through a shared
SQLite database and a shared folder on disk, which means any one of them can be
restarted without the others noticing.

| | | |
|---|---|---|
| `api/` | TypeScript | Control plane — owns projects and deployment records |
| `worker/` | TypeScript | Claims queued builds, runs them in Docker, writes output |
| `proxy/` | Go | Front door — routes each request by its `Host` header |

The full architecture, the reasoning behind each decision, and a glossary of the
concepts involved: **[`docs/architecture.html`](docs/architecture.html)**.

## Milestones

- [x] **M0** — Go proxy serving folders by hostname (proves routing works)
- [ ] **M1** — SQLite schema and the api; deployments queue but nothing builds
- [ ] **M2** — Build worker: clone, build in Docker, stream logs, store output
- [ ] **M3** — Wire them together; first repo URL in, live site out
- [ ] **M4** — Aliases, promote to production, rollback
- [ ] **M5** — Dashboard with live build logs
- [ ] **M6** — GitHub webhooks, concurrent builds, garbage collection

## Scope

Static sites only, one user, plain HTTP, one machine. No SSR or serverless
functions, no accounts, no TLS, no CDN. Each of those is a separate system and
is easier to add on top of a working static pipeline than to design around.

## Requirements

Node 20+, Go 1.22+, and Docker running locally.
