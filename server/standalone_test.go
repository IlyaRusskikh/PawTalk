package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRebindPreservesAccessAndReplacesCertificateForAddress(t *testing.T) {
	state, password, err := createState("203.0.113.10")
	if err != nil {
		t.Fatal(err)
	}
	before := state
	if err := rebindRoom(&state, "0.0.0.0"); err == nil || state != before {
		t.Fatal("invalid rebind mutated state")
	}
	if err := rebindRoom(&state, state.IP); err != nil || state != before {
		t.Fatal("same address should be a no-op")
	}
	if err := rebindRoom(&state, "198.51.100.20"); err != nil {
		t.Fatal(err)
	}
	if state.IP != "198.51.100.20" || state.APIKey != before.APIKey || state.PasswordHash != before.PasswordHash || !verifyPassword(state.PasswordHash, password) {
		t.Fatal("rebind lost access")
	}
	if state.APISecret == before.APISecret || state.Certificate == before.Certificate || invitation(state) == invitation(before) {
		t.Fatal("rebind failed to replace certificate/session key")
	}
	if _, _, err := stateCertificate(state); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := saveState(dir, state); err != nil {
		t.Fatal(err)
	}
	loaded, err := readState(dir)
	if err != nil || loaded != state {
		t.Fatal("rebound state did not round trip", err)
	}
}

func TestPasswordRotationRevokesVoiceTokensAndKeepsRoom(t *testing.T) {
	state, oldPassword, err := createState("203.0.113.10")
	if err != nil {
		t.Fatal(err)
	}
	before := state
	a := testApp(t)
	a.cfg.APIKey = state.APIKey
	a.cfg.APISecret = state.APISecret
	oldToken, err := a.token("former-member", "Former member")
	if err != nil {
		t.Fatal(err)
	}
	if err := rotateRoomPassword(&state, "new-room-password"); err != nil {
		t.Fatal(err)
	}
	if state.APISecret == before.APISecret || verifyPassword(state.PasswordHash, oldPassword) || !verifyPassword(state.PasswordHash, "new-room-password") {
		t.Fatal("password/session signing secret not rotated")
	}
	if invitation(state) != invitation(before) || state.Certificate != before.Certificate || state.PrivateKey != before.PrivateKey {
		t.Fatal("password rotation changed room identity")
	}
	pieces := strings.Split(oldToken, ".")
	signature, err := b64.DecodeString(pieces[2])
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, []byte(state.APISecret))
	mac.Write([]byte(pieces[0] + "." + pieces[1]))
	if hmac.Equal(signature, mac.Sum(nil)) {
		t.Fatal("old LiveKit token remains valid")
	}
}

func TestStandaloneStateSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	state, password, err := createState("203.0.113.10")
	if err != nil {
		t.Fatal(err)
	}
	if !verifyPassword(state.PasswordHash, password) {
		t.Fatal("generated password rejected")
	}
	if err = saveState(dir, state); err != nil {
		t.Fatal(err)
	}
	loaded, err := readState(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != state || invitation(loaded) != invitation(state) {
		t.Fatal("restart changed credentials or invitation")
	}
	data, _ := os.ReadFile(filepath.Join(dir, "state.json"))
	if strings.Contains(string(data), password) {
		t.Fatal("plaintext password persisted")
	}
	loaded.PasswordHash, err = passwordHash("replacement-password")
	if err != nil {
		t.Fatal(err)
	}
	if err = saveState(dir, loaded); err != nil {
		t.Fatal(err)
	}
	rotated, err := readState(dir)
	if err != nil {
		t.Fatal(err)
	}
	if verifyPassword(rotated.PasswordHash, password) || !verifyPassword(rotated.PasswordHash, "replacement-password") || invitation(rotated) != invitation(state) {
		t.Fatal("password rotation changed invitation or kept old password")
	}
	if err = os.WriteFile(filepath.Join(dir, "state.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = readState(dir); err == nil {
		t.Fatal("corrupt state accepted")
	}
}

func TestStandaloneAddressesAndCertificate(t *testing.T) {
	for _, ip := range []string{"", "example.com", "0.0.0.0", "::", "224.0.0.1"} {
		if _, _, err := createState(ip); err == nil {
			t.Fatalf("accepted invalid address %q", ip)
		}
	}
	state, _, err := createState("2001:db8::1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(invitation(state), "pawtalk://[2001:db8::1]:18443/") {
		t.Fatal(invitation(state))
	}
	state.IP = "203.0.113.20"
	if _, _, err = stateCertificate(state); err == nil {
		t.Fatal("mismatched certificate accepted")
	}
}

func TestStandaloneIgnoresForwardedHeaders(t *testing.T) {
	state, _, err := createState("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	handler := standaloneHandler(state, nil)
	for i := 0; i < 6; i++ {
		r := httptest.NewRequest("POST", "/api/connect", strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Real-IP", "192.0.2."+string(rune('1'+i)))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if i == 5 && w.Code != 429 {
			t.Fatal("forwarded header bypassed public listener rate limit")
		}
	}
}
