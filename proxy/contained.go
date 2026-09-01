package main

import (
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"syscall"
)

type containedFS struct {
	inner fs.FS
}

// os.Root refuses a path that leaves the root — an escaping symlink included — with an
// unexported sentinel, which http.FileServerFS maps to 500. A 500 tells a prober the file
// is there and is merely being withheld, so it has to read as 404 instead. The sentinel
// cannot be compared against, but every refusal that came from the kernel arrives as a
// syscall.Errno, so anything else came from the containment check and names nothing
// inside this filesystem. If a future Go breaks that, the escape reverts to a 500 and
// stays refused.
func (contained containedFS) Open(name string) (fs.File, error) {
	file, err := contained.inner.Open(name)
	if err == nil {
		return file, nil
	}

	var errno syscall.Errno
	if errors.As(err, &errno) {
		return nil, err
	}

	return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}

func serveContainedDir(w http.ResponseWriter, r *http.Request, dir string) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("open deployment root %s: %v", dir, err)
		}
		http.NotFound(w, r)
		return
	}
	defer func() {
		if err := root.Close(); err != nil {
			log.Printf("close deployment root %s: %v", dir, err)
		}
	}()

	http.FileServerFS(containedFS{inner: root.FS()}).ServeHTTP(w, r)
}
