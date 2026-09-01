package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"path/filepath"
)

type DeploymentServer struct {
	store          *DeploymentStore
	deploymentsDir string
}

func NewDeploymentServer(store *DeploymentStore, deploymentsDir string) *DeploymentServer {
	return &DeploymentServer{store: store, deploymentsDir: deploymentsDir}
}

// net.SplitHostPort fails rather than passing through a host that carries no port, so the
// original stands whenever it declines.
func RequestHostname(r *http.Request) (Hostname, bool) {
	host := r.Host
	if withoutPort, _, err := net.SplitHostPort(host); err == nil {
		host = withoutPort
	}
	return ParseHostname(host)
}

func (server *DeploymentServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	hostname, isWellFormed := RequestHostname(r)
	if !isWellFormed {
		http.Error(w, "unknown host", http.StatusNotFound)
		return
	}

	id, err := server.store.ResolveHostname(r.Context(), hostname)
	if err != nil {
		if errors.Is(err, ErrHostnameUnknown) {
			http.Error(w, fmt.Sprintf("unknown host: %s", hostname), http.StatusNotFound)
			return
		}
		log.Printf("resolve %s for %s: %v", hostname, r.URL.Path, err)
		http.Error(w, "the proxy could not resolve this host", http.StatusInternalServerError)
		return
	}

	serveContainedDir(w, r, filepath.Join(server.deploymentsDir, string(id)))
}
