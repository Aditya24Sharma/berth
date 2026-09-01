package main

import (
	"regexp"
	"strings"
)

type DeploymentID string

type Hostname string

const maxHostnameLength = 253

var deploymentIDPattern = regexp.MustCompile(`^dpl_[0-9a-f]{12}$`)

// Underscore is not an RFC 1123 hostname character, but a deployment id contains one
// and every deployment is promised a URL at <id>.localhost. macOS resolves such a name
// to 127.0.0.1, so the id format wins and this accepts it, as shared/ids.ts does.
const hostnameLabel = `[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?`

var hostnamePattern = regexp.MustCompile(`^` + hostnameLabel + `(\.` + hostnameLabel + `)*$`)

func ParseDeploymentID(value string) (DeploymentID, bool) {
	if !deploymentIDPattern.MatchString(value) {
		return "", false
	}
	return DeploymentID(value), true
}

// DNS names are case-insensitive, so lowercasing is canonicalisation rather than
// mutation — and it is what makes the schema's hostname_is_lowercase CHECK
// unreachable from application code.
func ParseHostname(value string) (Hostname, bool) {
	canonical := strings.ToLower(value)
	if len(canonical) == 0 || len(canonical) > maxHostnameLength {
		return "", false
	}
	if !hostnamePattern.MatchString(canonical) {
		return "", false
	}
	return Hostname(canonical), true
}

func FirstLabel(hostname Hostname) string {
	name := string(hostname)
	dot := strings.Index(name, ".")
	if dot == -1 {
		return name
	}
	return name[:dot]
}
