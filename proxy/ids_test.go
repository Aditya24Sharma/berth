package main

import (
	"strings"
	"testing"
)

func TestParseDeploymentIDAcceptsMintedIDs(t *testing.T) {
	for _, value := range []string{
		"dpl_0123456789ab",
		"dpl_000000000000",
		"dpl_ffffffffffff",
	} {
		id, isID := ParseDeploymentID(value)
		if !isID {
			t.Errorf("ParseDeploymentID(%q) rejected a minted id", value)
			continue
		}
		if string(id) != value {
			t.Errorf("ParseDeploymentID(%q) = %q, want the value unchanged", value, id)
		}
	}
}

func TestParseDeploymentIDRejectsEverythingElse(t *testing.T) {
	for name, value := range map[string]string{
		"empty":              "",
		"traversal":          "../../etc",
		"traversal prefixed": "dpl_../..",
		"traversal suffixed": "dpl_0123456789ab/../../etc/passwd",
		"encoded traversal":  "dpl_%2e%2e%2f%2e%2e",
		"absolute path":      "/etc/passwd",
		"uppercase hex":      "dpl_0123456789AB",
		"too short":          "dpl_0123456789a",
		"too long":           "dpl_0123456789abc",
		"not hex":            "dpl_0123456789ag",
		"project id":         "prj_0123456789ab",
		"prefix only":        "dpl_",
		"no prefix":          "0123456789ab",
		"wrong separator":    "dpl-0123456789ab",
		"leading space":      " dpl_0123456789ab",
		"trailing newline":   "dpl_0123456789ab\n",
		"leading newline":    "\ndpl_0123456789ab",
		"embedded nul":       "dpl_0123456789ab\x00",
		"hostname":           "dpl_0123456789ab.localhost",
		"sql injection":      "dpl_0123456789ab' OR '1'='1",
		"tilde":              "~/.berth",
	} {
		if id, isID := ParseDeploymentID(value); isID {
			t.Errorf("%s: ParseDeploymentID(%q) accepted it as %q", name, value, id)
		}
	}
}

func TestParseHostnameAcceptsServableHosts(t *testing.T) {
	for _, value := range []string{
		"localhost",
		"dpl_0123456789ab.localhost",
		"alpha.localhost",
		"my-site.localhost",
		"a",
		"0",
		"_",
		"deep.sub.domain.example.com",
		strings.Repeat("a", maxHostnameLength),
	} {
		if _, isHostname := ParseHostname(value); !isHostname {
			t.Errorf("ParseHostname(%q) rejected a servable host", value)
		}
	}
}

func TestParseHostnameCanonicalisesToLowercase(t *testing.T) {
	for value, want := range map[string]string{
		"ALPHA.LOCALHOST":            "alpha.localhost",
		"Alpha.Localhost":            "alpha.localhost",
		"DPL_0123456789AB.localhost": "dpl_0123456789ab.localhost",
	} {
		hostname, isHostname := ParseHostname(value)
		if !isHostname {
			t.Errorf("ParseHostname(%q) rejected a host that differs only in case", value)
			continue
		}
		if string(hostname) != want {
			t.Errorf("ParseHostname(%q) = %q, want %q", value, hostname, want)
		}
	}
}

func TestParseHostnameRejectsEverythingElse(t *testing.T) {
	for name, value := range map[string]string{
		"empty":              "",
		"traversal":          "../../etc",
		"traversal label":    "alpha.localhost/../../etc/passwd",
		"dot label":          "..",
		"single dot":         ".",
		"empty first label":  ".localhost",
		"empty last label":   "localhost.",
		"empty inner label":  "alpha..localhost",
		"leading dash":       "-alpha.localhost",
		"trailing dash":      "alpha-.localhost",
		"dash only":          "-",
		"slash":              "alpha/localhost",
		"backslash":          "alpha\\localhost",
		"space":              "alpha localhost",
		"port":               "alpha.localhost:3000",
		"scheme":             "http://alpha.localhost",
		"userinfo":           "user@alpha.localhost",
		"bracketed ipv6":     "[::1]",
		"header injection":   "alpha.localhost\r\nX-Injected: 1",
		"trailing newline":   "alpha.localhost\n",
		"embedded nul":       "alpha.localhost\x00",
		"non ascii":          "älpha.localhost",
		"wildcard":           "*.localhost",
		"query":              "alpha.localhost?x=1",
		"one over the limit": strings.Repeat("a", maxHostnameLength+1),
	} {
		if hostname, isHostname := ParseHostname(value); isHostname {
			t.Errorf("%s: ParseHostname(%q) accepted it as %q", name, value, hostname)
		}
	}
}

func TestFirstLabelTakesTheLeadingLabel(t *testing.T) {
	for value, want := range map[Hostname]string{
		"dpl_0123456789ab.localhost":  "dpl_0123456789ab",
		"alpha.localhost":             "alpha",
		"localhost":                   "localhost",
		"deep.sub.domain.example.com": "deep",
	} {
		if got := FirstLabel(value); got != want {
			t.Errorf("FirstLabel(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestDeploymentIDRoundTripsThroughItsHostname(t *testing.T) {
	const minted = "dpl_0123456789ab"

	id, isID := ParseDeploymentID(minted)
	if !isID {
		t.Fatalf("ParseDeploymentID(%q) rejected a minted id", minted)
	}

	hostname, isHostname := ParseHostname(string(id) + ".localhost")
	if !isHostname {
		t.Fatalf("ParseHostname(%q) rejected the URL every deployment is promised", string(id)+".localhost")
	}

	resolved, isResolvedID := ParseDeploymentID(FirstLabel(hostname))
	if !isResolvedID {
		t.Fatalf("FirstLabel(%q) = %q, which no longer parses as a deployment id", hostname, FirstLabel(hostname))
	}
	if resolved != id {
		t.Errorf("round trip produced %q, want %q", resolved, id)
	}
}
