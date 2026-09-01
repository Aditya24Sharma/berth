package main

import (
	"log"
	"net/http"
)

func main() {
	store, err := OpenDeploymentStore(DatabasePath())
	if err != nil {
		log.Fatalf("berth proxy cannot start: %v", err)
	}

	address := ProxyAddress()
	log.Printf("berth proxy listening on %s, serving deployments from %s", address, DeploymentsDir())
	log.Fatal(http.ListenAndServe(address, NewDeploymentServer(store, DeploymentsDir())))
}
