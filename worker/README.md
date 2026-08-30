# worker

Claims queued deployments, clones the repo, runs the build inside a Docker
container, streams logs to the database and writes the build output to the
deployments store.

Runs as its own process so a build can outlive any single HTTP request, and so
a crash mid-build leaves a recorded `building` row rather than silence.
