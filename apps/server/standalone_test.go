package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRebindPreservesMediaIdentityAndReplacesCertificate(t *testing.T) {
	state, err := createState("203.0.113.10")
	if err != nil {
		t.Fatal(err)
	}
	before := state
	if err := rebindRoom(&state, "0.0.0.0"); err == nil || state != before {
		t.Fatal("invalid rebind mutated state")
	}
	if err := rebindRoom(&state, state.IP); err != nil || state != before {
		t.Fatal("same address must be a no-op")
	}
	if err := rebindRoom(&state, "198.51.100.20"); err != nil {
		t.Fatal(err)
	}
	if state.IP != "198.51.100.20" || state.APIKey != before.APIKey || state.APISecret == before.APISecret || state.Certificate == before.Certificate {
		t.Fatal("rebind did not preserve API identity and replace TLS/media secret")
	}
	dir := t.TempDir()
	if err := saveState(dir, state); err != nil {
		t.Fatal(err)
	}
	loaded, err := readState(dir)
	if err != nil || loaded != state {
		t.Fatal("state lost after restart", err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "state.json"))
	if strings.Contains(string(data), "PasswordHash") {
		t.Fatal("legacy admission state persisted")
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readState(dir); err == nil {
		t.Fatal("invalid host state accepted")
	}
}

func TestStandaloneAddressesAndCertificate(t *testing.T) {
	for _, ip := range []string{"", "example.com", "0.0.0.0", "::", "224.0.0.1"} {
		if _, err := createState(ip); err == nil {
			t.Fatalf("accepted invalid address %q", ip)
		}
	}
	state, err := createState("2001:db8::1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(invitation(state), "pawtalk://[2001:db8::1]:18443/") {
		t.Fatal("invalid IPv6 address")
	}
	state.IP = "203.0.113.20"
	if _, _, err := stateCertificate(state); err == nil {
		t.Fatal("mismatched certificate accepted")
	}
}

func TestStorageConfiguration(t *testing.T) {
	for value, expected := range map[string]int64{"": defaultChatStorage, "0": 0, "64": 64 * 1024 * 1024} {
		t.Setenv("PAWTALK_CHAT_MAX_MB", value)
		actual, err := chatStorageLimit()
		if err != nil || actual != expected {
			t.Fatal(value, actual, err)
		}
	}
	for _, value := range []string{"-1", "overflow", "9223372036854775807"} {
		t.Setenv("PAWTALK_CHAT_MAX_MB", value)
		if _, err := chatStorageLimit(); err == nil {
			t.Fatal("invalid history limit accepted")
		}
	}
}
