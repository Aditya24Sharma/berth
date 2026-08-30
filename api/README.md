# api

Control plane. HTTP server (TypeScript) that owns projects, accepts deploy
requests and reports status and logs.

Writes a `queued` deployment row and returns immediately — it never builds
anything itself, so a request never outlives the HTTP connection.
