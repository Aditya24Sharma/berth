package main

import (
	"log"
	"os"
	"path/filepath"
)

const defaultProxyPort = "3000"

// The signature has no error because every caller wants a path, and a process with
// neither BERTH_DATA_DIR nor a home directory has nowhere to read deployments from.
func BerthDataDir() string {
	if dir, isSet := os.LookupEnv("BERTH_DATA_DIR"); isSet {
		return dir
	}

	home, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("resolve home directory for the default data directory: %v (set BERTH_DATA_DIR)", err)
	}
	return filepath.Join(home, ".berth")
}

func DatabasePath() string {
	return filepath.Join(BerthDataDir(), "berth.db")
}

func DeploymentsDir() string {
	return filepath.Join(BerthDataDir(), "deployments")
}

func DeploymentDir(id DeploymentID) string {
	return filepath.Join(DeploymentsDir(), string(id))
}

func ProxyAddress() string {
	if port, isSet := os.LookupEnv("BERTH_PROXY_PORT"); isSet {
		return ":" + port
	}
	return ":" + defaultProxyPort
}
