# proxy

The front door (Go). Every visitor request lands here.

Reads the `Host` header, resolves it to a deployment id — directly for
`<id>.localhost`, or through the aliases table for a name like
`myapp.localhost` — and serves that deployment's files from disk.
