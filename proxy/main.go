package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
)

type Hostname string

type siteRouter map[Hostname]http.Handler

func requestHostname(r *http.Request) Hostname {
	if host, _, err := net.SplitHostPort(r.Host); err == nil {
		return Hostname(host)
	}
	return Hostname(r.Host)
}

func (sites siteRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	hostname := requestHostname(r)

	site, isKnownHost := sites[hostname]
	if !isKnownHost {
		http.Error(w, fmt.Sprintf("unknown host: %s", hostname), http.StatusNotFound)
		return
	}

	site.ServeHTTP(w, r)
}

func main() {
	sites := siteRouter{
		"alpha.localhost": http.FileServer(http.Dir("testdata/alpha")),
		"beta.localhost":  http.FileServer(http.Dir("testdata/beta")),
	}

	log.Println("berth proxy listening on :3000")
	log.Fatal(http.ListenAndServe(":3000", sites))
}
