package main

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	readyIndexContents  = "<h1>ready</h1>"
	queuedIndexContents = "<h1>not yet</h1>"
)

func writeDatabase(t *testing.T, path string) {
	t.Helper()

	schema, err := os.ReadFile(filepath.Join("..", "shared", "schema.sql"))
	if err != nil {
		t.Fatalf("read the real schema: %v", err)
	}

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
}

func writeDeployment(t *testing.T, id DeploymentID, index string) {
	t.Helper()

	dir := DeploymentDir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create %s: %v", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(index), 0o644); err != nil {
		t.Fatalf("write %s/index.html: %v", dir, err)
	}
}

func newServer(t *testing.T) *DeploymentServer {
	t.Helper()

	dataDir := t.TempDir()
	t.Setenv("BERTH_DATA_DIR", dataDir)

	writeDatabase(t, DatabasePath())

	if err := os.WriteFile(filepath.Join(dataDir, "secret.txt"), []byte(secretContents), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	writeDeployment(t, seedReadyID, readyIndexContents)
	writeDeployment(t, seedQueuedID, queuedIndexContents)

	escape := filepath.Join(DeploymentDir(seedReadyID), "escape.txt")
	if err := os.Symlink("../../secret.txt", escape); err != nil {
		t.Fatalf("create escaping symlink: %v", err)
	}

	store, err := OpenDeploymentStore(DatabasePath())
	if err != nil {
		t.Fatalf("open the seeded database: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close the store: %v", err)
		}
	})

	return NewDeploymentServer(store, DeploymentsDir())
}

func get(t *testing.T, server *DeploymentServer, host string, path string) *httptest.ResponseRecorder {
	t.Helper()

	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Host = host

	recorder := httptest.NewRecorder()
	server.ServeHTTP(recorder, request)
	return recorder
}

func TestServerServesAReadyDeploymentByItsID(t *testing.T) {
	server := newServer(t)

	tests := []struct {
		name string
		host string
	}{
		{"bare host", string(seedReadyID) + ".localhost"},
		{"host with a port", string(seedReadyID) + ".localhost:3000"},
		{"host in mixed case", strings.ToUpper(string(seedReadyID)) + ".LocalHost"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := get(t, server, test.host, "/")

			if response.Code != http.StatusOK {
				t.Fatalf("status %d for %s, want 200: %s", response.Code, test.host, response.Body)
			}
			if response.Body.String() != readyIndexContents {
				t.Errorf("body %q, want %q", response.Body, readyIndexContents)
			}
		})
	}
}

func TestServerServesTheSameBytesThroughAnAlias(t *testing.T) {
	server := newServer(t)

	direct := get(t, server, string(seedReadyID)+".localhost", "/")
	alias := get(t, server, "site.localhost", "/")

	if alias.Code != http.StatusOK {
		t.Fatalf("status %d for site.localhost, want 200: %s", alias.Code, alias.Body)
	}
	if alias.Body.String() != direct.Body.String() {
		t.Errorf("alias served %q, the id served %q", alias.Body, direct.Body)
	}
}

func TestServerAnswers404ForAnythingThatIsNotAReadyDeployment(t *testing.T) {
	server := newServer(t)

	tests := []struct {
		name string
		host string
	}{
		{"unknown host", "nowhere.localhost"},
		{"queued deployment whose directory exists", string(seedQueuedID) + ".localhost"},
		{"alias to a building deployment", "stale.localhost"},
		{"well-formed id with no row", "dpl_ffffffffffff.localhost"},
		{"host that is not a hostname", "not a host"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := get(t, server, test.host, "/")

			if response.Code != http.StatusNotFound {
				t.Fatalf("status %d for %s, want 404: %s", response.Code, test.host, response.Body)
			}
			if !strings.Contains(response.Body.String(), "unknown host") {
				t.Errorf("body %q, want it to say the host is unknown", response.Body)
			}
			if strings.Contains(response.Body.String(), queuedIndexContents) {
				t.Errorf("response served the deployment anyway: %q", response.Body)
			}
		})
	}
}

func TestServerRefusesASymlinkEscapingTheDeployment(t *testing.T) {
	server := newServer(t)

	response := get(t, server, string(seedReadyID)+".localhost", "/escape.txt")

	if response.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404 — a 500 tells a prober the file is there", response.Code)
	}
	if strings.Contains(response.Body.String(), secretContents) {
		t.Errorf("response leaked the secret: %q", response.Body)
	}
}

func TestServerAnswers500WhenTheDatabaseCannotBeRead(t *testing.T) {
	server := newServer(t)

	if err := server.store.Close(); err != nil {
		t.Fatalf("close the store: %v", err)
	}

	response := get(t, server, "site.localhost", "/")

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500 — a database fault is not a missing site: %s", response.Code, response.Body)
	}
	if strings.Contains(response.Body.String(), "unknown host") {
		t.Errorf("body %q reports a database fault as an unknown host", response.Body)
	}
}

func TestRequestHostnameStripsThePort(t *testing.T) {
	tests := []struct {
		host     string
		want     Hostname
		wantOK   bool
		testName string
	}{
		{"site.localhost:3000", "site.localhost", true, "port"},
		{"site.localhost", "site.localhost", true, "no port"},
		{"SITE.localhost:3000", "site.localhost", true, "mixed case"},
		{"dpl_0123456789ab.localhost:3000", "dpl_0123456789ab.localhost", true, "underscore in the id"},
		{"", "", false, "empty"},
		{"site .localhost", "", false, "space"},
	}

	for _, test := range tests {
		t.Run(test.testName, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Host = test.host

			got, isWellFormed := RequestHostname(request)
			if isWellFormed != test.wantOK || got != test.want {
				t.Errorf("RequestHostname(%q) = %q, %t, want %q, %t", test.host, got, isWellFormed, test.want, test.wantOK)
			}
		})
	}
}
