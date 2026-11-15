package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type testMemberSigner struct{ root, device ed25519.PrivateKey }

func newTestMemberSigner(seed byte) testMemberSigner {
	return testMemberSigner{ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, 32)), ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed + 100}, 32))}
}
func (k testMemberSigner) proof(t *testing.T, s *membershipStore, method, uri string, body []byte) membershipProof {
	t.Helper()
	c, err := s.challenge(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	p := membershipProof{ProfileKey: b64.EncodeToString(k.root.Public().(ed25519.PublicKey)), DeviceKey: b64.EncodeToString(k.device.Public().(ed25519.PublicKey)), Challenge: c.Challenge}
	frame, _ := signatureFrame("pawtalk-device-v2", p.ProfileKey, p.DeviceKey)
	p.Certificate = b64.EncodeToString(ed25519.Sign(k.root, frame))
	hash := sha256.Sum256(body)
	frame, _ = signatureFrame("pawtalk-request-v2", c.ServerID, p.Binding, method, uri, c.Challenge, c.Nonce, hex.EncodeToString(hash[:]))
	p.Signature = b64.EncodeToString(ed25519.Sign(k.device, frame))
	return p
}
func activateTestMember(t *testing.T, s *membershipStore, k testMemberSigner, role string) memberIdentity {
	t.Helper()
	p := k.proof(t, s, "POST", "/test", nil)
	id, err := s.proveDevice(context.Background(), p, "POST", "/test", nil, "Test", "Test device", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO memberships(profile_id,state,joined_at) VALUES(?,'active',?)", []any{id.ProfileID, s.now().UnixMilli()}},
		{"INSERT INTO profile_roles(profile_id,role_id) VALUES(?,?)", []any{id.ProfileID, role}},
		{"INSERT INTO profile_controls(profile_id,primary_device_id) VALUES(?,?)", []any{id.ProfileID, id.DeviceID}},
	} {
		if _, err = s.db.Exec(q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return id
}
func loginTestMember(t *testing.T, s *membershipStore, k testMemberSigner) memberSession {
	t.Helper()
	p := k.proof(t, s, "POST", "/api/v2/session", []byte(`{}`))
	session, err := s.session(context.Background(), p, "POST", "/api/v2/session", []byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func TestMembershipAuthReplayAndExpiry(t *testing.T) {
	s := testMembershipStore(t)
	k := newTestMemberSigner(1)
	activateTestMember(t, s, k, "member")
	p := k.proof(t, s, "POST", "/api/v2/session", []byte(`{}`))
	if _, err := s.session(context.Background(), p, "POST", "/api/v2/session", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.session(context.Background(), p, "POST", "/api/v2/session", []byte(`{}`)); err == nil {
		t.Fatal("challenge replay accepted")
	}
	clock := s.now()
	s.now = func() time.Time { return clock }
	p = k.proof(t, s, "POST", "/api/v2/session", []byte(`{}`))
	clock = clock.Add(61 * time.Second)
	if _, err := s.session(context.Background(), p, "POST", "/api/v2/session", []byte(`{}`)); err == nil {
		t.Fatal("expired challenge accepted")
	}
}

func TestMembershipSessionsUseCurrentRolesAndBan(t *testing.T) {
	s := testMembershipStore(t)
	k := newTestMemberSigner(1)
	id := activateTestMember(t, s, k, "moderator")
	session := loginTestMember(t, s, k)
	state, err := s.state(context.Background(), session.Token)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Self.allows("invite.create") || state.Self.allows("member.kick") || len(state.Members) != 1 || !state.Members[0].Online {
		t.Fatal("wrong moderator/chat-only state")
	}
	if _, err = s.db.Exec("UPDATE profile_roles SET role_id='member' WHERE profile_id=?", id.ProfileID); err != nil {
		t.Fatal(err)
	}
	state, err = s.state(context.Background(), session.Token)
	if err != nil {
		t.Fatal(err)
	}
	if state.Self.allows("invite.create") {
		t.Fatal("old session retained moderator role")
	}
	if _, err = s.db.Exec("INSERT INTO ban_actions(ban_id,issued_by_profile_id,created_at) VALUES('test-ban',?,?)", id.ProfileID, s.now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec("INSERT INTO ban_subjects(ban_id,profile_id) VALUES('test-ban',?)", id.ProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.state(context.Background(), session.Token); err == nil {
		t.Fatal("banned existing session accepted")
	}
	p := k.proof(t, s, "POST", "/api/v2/session", []byte(`{}`))
	if _, err = s.session(context.Background(), p, "POST", "/api/v2/session", []byte(`{}`)); err == nil {
		t.Fatal("banned identity issued new session")
	}
	if _, err = s.db.Exec("UPDATE memberships SET state='kicked' WHERE profile_id=?", id.ProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.heartbeat(context.Background(), session.Token); err == nil {
		t.Fatal("kicked member heartbeat accepted")
	}
}

func TestMembershipBindingUsesMainRoleAndBackgroundPresence(t *testing.T) {
	s := testMembershipStore(t)
	a, b := newTestMemberSigner(1), newTestMemberSigner(2)
	ai := activateTestMember(t, s, a, "member")
	bi := activateTestMember(t, s, b, "admin")
	bs := loginTestMember(t, s, b)
	if _, err := s.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)", bi.ProfileID, ai.ProfileID, s.now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE memberships SET state='linked' WHERE profile_id=?", bi.ProfileID); err != nil {
		t.Fatal(err)
	}
	state, err := s.state(context.Background(), bs.Token)
	if err != nil {
		t.Fatal(err)
	}
	if state.Self.Role != "member" || state.Self.allows("role.manage") || len(state.Members) != 1 || len(state.Devices) != 2 {
		t.Fatal("binding authority/roster incorrect")
	}
	clock := s.now()
	s.now = func() time.Time { return clock.Add(46 * time.Second) }
	state, err = s.state(context.Background(), bs.Token)
	if err != nil {
		t.Fatal(err)
	}
	if state.Members[0].Online {
		t.Fatal("cached session asserted online without heartbeat")
	}
	if _, err = s.heartbeat(context.Background(), bs.Token); err != nil {
		t.Fatal(err)
	}
	state, err = s.state(context.Background(), bs.Token)
	if err != nil || !state.Members[0].Online {
		t.Fatal("heartbeat did not restore presence", err)
	}
}

func TestMembershipHTTPPrivacyAndProtocol(t *testing.T) {
	s := testMembershipStore(t)
	server := httptest.NewServer(newMembershipHandler(s, config{}))
	defer server.Close()
	response, err := server.Client().Get(server.URL + "/api/v2/state")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 401 || bytes.Contains(data, []byte(`"members"`)) {
		t.Fatalf("state leaked: %d %s", response.StatusCode, data)
	}
	response, err = server.Client().Get(server.URL + "/api/config")
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	json.NewDecoder(response.Body).Decode(&cfg)
	response.Body.Close()
	if cfg["apiProtocolVersion"] != float64(2) || cfg["e2eeRequired"] != true || cfg["initialized"] != false {
		t.Fatal("wrong policy", cfg)
	}
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/connect", bytes.NewBufferString(`{}`))
	response, err = server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 426 {
		t.Fatal("legacy API accepted", response.StatusCode)
	}
}
