package main

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	seedReadyID    = DeploymentID("dpl_0123456789ab")
	seedBuildingID = DeploymentID("dpl_00000000bbbb")
	seedQueuedID   = DeploymentID("dpl_00000000cccc")
	seedFailedID   = DeploymentID("dpl_00000000dddd")
)

var seedRows = []string{
	`INSERT INTO projects (id, name, repo_url, build_cmd, output_dir)
	 VALUES ('prj_0123456789ab', 'site', 'https://example.com/site.git', 'npm run build', 'dist')`,

	`INSERT INTO deployments (id, project_id, status, started_at, finished_at)
	 VALUES ('dpl_0123456789ab', 'prj_0123456789ab', 'ready', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')`,
	`INSERT INTO deployments (id, project_id, status, started_at)
	 VALUES ('dpl_00000000bbbb', 'prj_0123456789ab', 'building', '2026-01-01T00:00:00Z')`,
	`INSERT INTO deployments (id, project_id, status)
	 VALUES ('dpl_00000000cccc', 'prj_0123456789ab', 'queued')`,
	`INSERT INTO deployments (id, project_id, status, started_at, finished_at, error)
	 VALUES ('dpl_00000000dddd', 'prj_0123456789ab', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 'build exited 1')`,
	`INSERT INTO deployments (id, project_id, status, started_at, finished_at)
	 VALUES ('../../etc/passwd', 'prj_0123456789ab', 'ready', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')`,

	`INSERT INTO aliases (hostname, deployment_id) VALUES ('site.localhost', 'dpl_0123456789ab')`,
	`INSERT INTO aliases (hostname, deployment_id) VALUES ('stale.localhost', 'dpl_00000000bbbb')`,
	`INSERT INTO aliases (hostname, deployment_id) VALUES ('traversal.localhost', '../../etc/passwd')`,
}

func writeSeededDatabase(t *testing.T) string {
	t.Helper()

	schema, err := os.ReadFile(filepath.Join("..", "shared", "schema.sql"))
	if err != nil {
		t.Fatalf("read the real schema: %v", err)
	}

	path := filepath.Join(t.TempDir(), "berth.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Errorf("close the seeding handle: %v", err)
		}
	}()

	if _, err := db.Exec(string(schema)); err != nil {
		t.Fatalf("apply shared/schema.sql: %v", err)
	}
	for _, row := range seedRows {
		if _, err := db.Exec(row); err != nil {
			t.Fatalf("seed %q: %v", row, err)
		}
	}
	return path
}

func openSeededStore(t *testing.T) *DeploymentStore {
	t.Helper()

	store, err := OpenDeploymentStore(writeSeededDatabase(t))
	if err != nil {
		t.Fatalf("open the seeded database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close the store: %v", err)
		}
	})
	return store
}

func TestResolveHostnameFindsReadyDeployments(t *testing.T) {
	store := openSeededStore(t)

	tests := []struct {
		name     string
		hostname Hostname
		want     DeploymentID
	}{
		{"direct id form", "dpl_0123456789ab.localhost", seedReadyID},
		{"alias form", "site.localhost", seedReadyID},
		{"bare deployment id with no suffix", "dpl_0123456789ab", seedReadyID},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := store.ResolveHostname(context.Background(), test.hostname)
			if err != nil {
				t.Fatalf("ResolveHostname(%q) = error %v, want %q", test.hostname, err, test.want)
			}
			if got != test.want {
				t.Errorf("ResolveHostname(%q) = %q, want %q", test.hostname, got, test.want)
			}
		})
	}
}

func TestResolveHostnameRejectsEverythingElseAsUnknown(t *testing.T) {
	store := openSeededStore(t)

	tests := []struct {
		name     string
		hostname Hostname
	}{
		{"building deployment by id", Hostname(seedBuildingID) + ".localhost"},
		{"queued deployment by id", Hostname(seedQueuedID) + ".localhost"},
		{"failed deployment by id", Hostname(seedFailedID) + ".localhost"},
		{"alias to a building deployment", "stale.localhost"},
		{"well-formed id with no row", "dpl_ffffffffffff.localhost"},
		{"unknown host", "nowhere.localhost"},
		{"first label is not a deployment id", "dpl_zzzzzzzzzzzz.localhost"},
		{"project id where a deployment id would go", "prj_0123456789ab.localhost"},
		{"deployment id below another label", "preview.dpl_0123456789ab.localhost"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := store.ResolveHostname(context.Background(), test.hostname)
			if !errors.Is(err, ErrHostnameUnknown) {
				t.Fatalf("ResolveHostname(%q) = %q, %v, want ErrHostnameUnknown", test.hostname, got, err)
			}
			if got != "" {
				t.Errorf("ResolveHostname(%q) returned id %q alongside ErrHostnameUnknown", test.hostname, got)
			}
		})
	}
}

func TestResolveHostnameReportsACorruptIdAsAnErrorNotAsUnknown(t *testing.T) {
	store := openSeededStore(t)

	got, err := store.ResolveHostname(context.Background(), "traversal.localhost")
	if err == nil {
		t.Fatalf("ResolveHostname(traversal.localhost) = %q, nil, want an error", got)
	}
	if errors.Is(err, ErrHostnameUnknown) {
		t.Errorf("a deployment id that is not a deployment id reported as ErrHostnameUnknown: %v", err)
	}
	if got != "" {
		t.Errorf("ResolveHostname(traversal.localhost) returned id %q alongside an error", got)
	}
}

func TestResolveHostnameReportsAnUnusableDatabaseAsAnErrorNotAsUnknown(t *testing.T) {
	store, err := OpenDeploymentStore(writeSeededDatabase(t))
	if err != nil {
		t.Fatalf("open the seeded database: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close the store: %v", err)
	}

	got, err := store.ResolveHostname(context.Background(), "site.localhost")
	if err == nil {
		t.Fatalf("ResolveHostname against a closed database = %q, nil, want an error", got)
	}
	if errors.Is(err, ErrHostnameUnknown) {
		t.Errorf("a broken database reported as ErrHostnameUnknown: %v", err)
	}
}

func TestOpenDeploymentStoreFailsWithoutADatabaseFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "berth.db")

	store, err := OpenDeploymentStore(path)
	if err == nil {
		if err := store.Close(); err != nil {
			t.Errorf("close the store: %v", err)
		}
		t.Fatal("OpenDeploymentStore succeeded against a database that does not exist")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("OpenDeploymentStore = %v, want an error wrapping fs.ErrNotExist", err)
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("OpenDeploymentStore = %v, want the message to name %s", err, path)
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, fs.ErrNotExist) {
		t.Errorf("OpenDeploymentStore created %s; the proxy must never write", path)
	}
}

func TestStoreRefusesWrites(t *testing.T) {
	store := openSeededStore(t)

	_, err := store.db.ExecContext(context.Background(),
		`INSERT INTO aliases (hostname, deployment_id) VALUES ('sneaky.localhost', 'dpl_0123456789ab')`)
	if err == nil {
		t.Fatal("an INSERT through the proxy's handle succeeded; mode=ro is not in force")
	}
	if !strings.Contains(err.Error(), "readonly") {
		t.Errorf("INSERT failed with %v, want SQLite's readonly refusal", err)
	}
}

func TestReadOnlyDSNNamesTheFileWithoutAnAuthority(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{"absolute", "/var/berth/berth.db", "file:/var/berth/berth.db?mode=ro&_pragma=busy_timeout(5000)"},
		{"relative", "berth.db", "file:berth.db?mode=ro&_pragma=busy_timeout(5000)"},
		{"containing a space", "/var/my berth/berth.db", "file:/var/my%20berth/berth.db?mode=ro&_pragma=busy_timeout(5000)"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := readOnlyDSN(test.path); got != test.want {
				t.Errorf("readOnlyDSN(%q) = %q, want %q", test.path, got, test.want)
			}
		})
	}
}
