package main

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

const secretContents = "TOP SECRET"

func newDeploymentWithEscapingSymlink(t *testing.T) string {
	t.Helper()

	dataDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataDir, "secret.txt"), []byte(secretContents), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}

	dir := filepath.Join(dataDir, "deployments", "dpl_0123456789ab")
	for _, sub := range []string{"nested", "listed"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatalf("create %s: %v", sub, err)
		}
	}

	files := map[string]string{
		"index.html":      "home",
		"about.html":      "about",
		"nested/deep.txt": "deep",
		"listed/a.txt":    "listed a",
	}
	for name, contents := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	if err := os.Symlink("../../secret.txt", filepath.Join(dir, "escape.txt")); err != nil {
		t.Fatalf("create escaping symlink: %v", err)
	}
	if err := os.Symlink("index.html", filepath.Join(dir, "inside.txt")); err != nil {
		t.Fatalf("create internal symlink: %v", err)
	}

	return dir
}

func recordGet(t *testing.T, handler http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
	return recorder
}

func containedHandler(dir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveContainedDir(w, r, dir)
	})
}

func TestHTTPDirServesSymlinkEscapingTheDeployment(t *testing.T) {
	dir := newDeploymentWithEscapingSymlink(t)

	response := recordGet(t, http.FileServer(http.Dir(dir)), "/escape.txt")

	if response.Code != http.StatusOK {
		t.Fatalf("http.Dir no longer serves the escape; got %d, want 200 — if the standard library was fixed, serveContainedDir may no longer be needed", response.Code)
	}
	if body := response.Body.String(); body != secretContents {
		t.Fatalf("http.Dir served %q, want %q", body, secretContents)
	}
}

func TestServeContainedDirRefusesSymlinkEscapingTheDeployment(t *testing.T) {
	dir := newDeploymentWithEscapingSymlink(t)

	response := recordGet(t, containedHandler(dir), "/escape.txt")

	if response.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404 — a 500 tells a prober the file is there", response.Code)
	}
	if body := response.Body.String(); strings.Contains(body, secretContents) {
		t.Errorf("response leaked the secret: %q", body)
	}
}

func TestServeContainedDirRoutes(t *testing.T) {
	dir := newDeploymentWithEscapingSymlink(t)
	handler := containedHandler(dir)

	cases := []struct {
		target     string
		wantStatus int
		wantBody   string
	}{
		{"/", http.StatusOK, "home"},
		{"/index.html", http.StatusMovedPermanently, ""},
		{"/about.html", http.StatusOK, "about"},
		{"/nested/deep.txt", http.StatusOK, "deep"},
		{"/inside.txt", http.StatusOK, "home"},
		{"/escape.txt", http.StatusNotFound, ""},
		{"/../secret.txt", http.StatusNotFound, ""},
		{"/%2e%2e/secret.txt", http.StatusNotFound, ""},
		{"/..%2f..%2fsecret.txt", http.StatusNotFound, ""},
		{"//etc/passwd", http.StatusNotFound, ""},
		{"/missing.txt", http.StatusNotFound, ""},
	}

	for _, testCase := range cases {
		t.Run(testCase.target, func(t *testing.T) {
			response := recordGet(t, handler, testCase.target)

			if response.Code != testCase.wantStatus {
				t.Errorf("status %d, want %d", response.Code, testCase.wantStatus)
			}
			if testCase.wantBody != "" && response.Body.String() != testCase.wantBody {
				t.Errorf("body %q, want %q", response.Body.String(), testCase.wantBody)
			}
			if strings.Contains(response.Body.String(), secretContents) {
				t.Errorf("response leaked the secret: %q", response.Body.String())
			}
		})
	}
}

func TestServeContainedDirListsDirectoryWithoutIndex(t *testing.T) {
	dir := newDeploymentWithEscapingSymlink(t)
	handler := containedHandler(dir)

	redirect := recordGet(t, handler, "/listed")
	if redirect.Code != http.StatusMovedPermanently {
		t.Errorf("status %d for /listed, want 301", redirect.Code)
	}
	if location := redirect.Header().Get("Location"); location != "listed/" {
		t.Errorf("Location %q, want %q", location, "listed/")
	}

	listing := recordGet(t, handler, "/listed/")
	if listing.Code != http.StatusOK {
		t.Fatalf("status %d for /listed/, want 200", listing.Code)
	}
	if !strings.Contains(listing.Body.String(), "a.txt") {
		t.Errorf("listing does not mention a.txt: %q", listing.Body.String())
	}
}

func TestServeContainedDirAnswersMissingDeploymentWith404(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "dpl_ffffffffffff")

	response := recordGet(t, containedHandler(dir), "/index.html")

	if response.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404", response.Code)
	}
}

func openContained(t *testing.T, dir string, name string) (fs.File, error) {
	t.Helper()

	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatalf("open root: %v", err)
	}
	t.Cleanup(func() {
		if err := root.Close(); err != nil {
			t.Errorf("close root: %v", err)
		}
	})

	return containedFS{inner: root.FS()}.Open(name)
}

func TestContainedFSReportsEscapeAsNotExist(t *testing.T) {
	dir := newDeploymentWithEscapingSymlink(t)

	file, err := openContained(t, dir, "escape.txt")
	if err == nil {
		if err := file.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
		t.Fatal("opened a symlink that escapes the deployment")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("err %v, want fs.ErrNotExist so http.FileServerFS answers 404", err)
	}
}

func TestContainedFSLeavesKernelErrorsUnchanged(t *testing.T) {
	dir := newDeploymentWithEscapingSymlink(t)

	_, err := openContained(t, dir, "missing.txt")
	if err == nil {
		t.Fatal("opened a file that does not exist")
	}

	var errno syscall.Errno
	if !errors.As(err, &errno) {
		t.Fatalf("err %v is no longer a syscall error; the wrapper is rewriting more than containment refusals", err)
	}
	if !errors.Is(errno, syscall.ENOENT) {
		t.Errorf("errno %v, want ENOENT", errno)
	}
}

func TestContainedFSOpensFilesInsideTheDeployment(t *testing.T) {
	dir := newDeploymentWithEscapingSymlink(t)

	file, err := openContained(t, dir, "nested/deep.txt")
	if err != nil {
		t.Fatalf("open nested/deep.txt: %v", err)
	}
	defer func() {
		if err := file.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	}()

	contents, err := io.ReadAll(file)
	if err != nil {
		t.Fatalf("read nested/deep.txt: %v", err)
	}
	if string(contents) != "deep" {
		t.Errorf("contents %q, want %q", contents, "deep")
	}
}
