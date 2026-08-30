CREATE TABLE IF NOT EXISTS projects (
    id          TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    repo_url    TEXT NOT NULL,
    build_cmd   TEXT NOT NULL,
    output_dir  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS deployments (
    id          TEXT NOT NULL PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    commit_sha  TEXT,
    status      TEXT NOT NULL DEFAULT 'queued',
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    started_at  TEXT,
    finished_at TEXT,

    CONSTRAINT status_is_known CHECK (
        status IN ('queued', 'building', 'ready', 'failed')
    ),
    CONSTRAINT commit_sha_is_a_full_sha CHECK (
        commit_sha IS NULL OR length(commit_sha) = 40
    ),
    CONSTRAINT state_carries_only_its_own_fields CHECK (
        CASE status
            WHEN 'queued'   THEN started_at IS     NULL AND finished_at IS     NULL AND error IS     NULL
            WHEN 'building' THEN started_at IS NOT NULL AND finished_at IS     NULL AND error IS     NULL
            WHEN 'ready'    THEN started_at IS NOT NULL AND finished_at IS NOT NULL AND error IS     NULL
            WHEN 'failed'   THEN started_at IS NOT NULL AND finished_at IS NOT NULL AND error IS NOT NULL
        END
    )
) STRICT;

CREATE TRIGGER IF NOT EXISTS deployments_follow_the_state_machine
BEFORE UPDATE OF status ON deployments
FOR EACH ROW WHEN NEW.status IS NOT OLD.status AND NOT (
    (OLD.status = 'queued'   AND NEW.status = 'building') OR
    (OLD.status = 'building' AND NEW.status IN ('ready', 'failed'))
)
BEGIN
    SELECT RAISE(ABORT, 'illegal deployment status transition');
END;

CREATE TABLE IF NOT EXISTS aliases (
    hostname      TEXT NOT NULL PRIMARY KEY,
    deployment_id TEXT NOT NULL REFERENCES deployments(id),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    CONSTRAINT hostname_is_lowercase CHECK (hostname = lower(hostname))
) STRICT;

CREATE TABLE IF NOT EXISTS logs (
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    stream        TEXT NOT NULL,
    line          TEXT NOT NULL,

    PRIMARY KEY (deployment_id, seq),
    CONSTRAINT stream_is_stdout_or_stderr CHECK (stream IN ('stdout', 'stderr'))
) STRICT;

CREATE INDEX IF NOT EXISTS deployments_by_status
    ON deployments (status, created_at);

CREATE INDEX IF NOT EXISTS deployments_by_project
    ON deployments (project_id, created_at DESC);
