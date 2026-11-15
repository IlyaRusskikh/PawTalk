package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestMembershipBanSubjectsSurviveUnlinkAndExpiry(t *testing.T) {
	s := testMembershipStore(t)
	clock := s.now()
	s.now = func() time.Time { return clock }
	ctx := context.Background()
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	b, c := newTestMemberSigner(2), newTestMemberSigner(3)
	bi := activateTestMember(t, s, b, "member")
	ci := activateTestMember(t, s, c, "moderator")
	bs, cs := loginTestMember(t, s, b), loginTestMember(t, s, c)
	if _, err := s.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)", ci.ProfileID, bi.ProfileID, clock.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE memberships SET state='linked' WHERE profile_id=?", ci.ProfileID); err != nil {
		t.Fatal(err)
	}
	expires := clock.Add(time.Minute).UnixMilli()
	if err := s.ban(ctx, admin.Token, bi.ProfileID, strings.Repeat("2", 32), &expires, "Synthetic test"); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{bs.Token, cs.Token} {
		if _, err := s.state(ctx, token); err == nil {
			t.Fatal("banned session remained authorized")
		}
	}
	raw, _ := json.Marshal(map[string]string{"requestId": strings.Repeat("3", 32)})
	uri := "/api/v2/devices/" + ci.DeviceID + "/unlink"
	proof := c.proof(t, s, "POST", uri, raw)
	if err := s.unlinkDevice(ctx, proof, "POST", uri, raw, ci.DeviceID, strings.Repeat("3", 32), false); err != nil {
		t.Fatal(err)
	}
	var bans int
	s.db.QueryRow("SELECT COUNT(*) FROM ban_subjects WHERE profile_id=?", ci.ProfileID).Scan(&bans)
	if bans != 1 {
		t.Fatal("unlink removed original ban subject")
	}
	invite, token := createTestInvite(t, s, admin.Token, "reusable", 1)
	if _, err := prepareTestInvite(t, s, c, invite.InviteID, token, strings.Repeat("4", 32)); err == nil {
		t.Fatal("banned detached device joined")
	}
	clock = clock.Add(61 * time.Second)
	p := c.proof(t, s, "POST", "/api/v2/session", []byte(`{}`))
	if _, err := s.session(ctx, p, "POST", "/api/v2/session", []byte(`{}`)); err == nil {
		t.Fatal("ban expiry restored membership automatically")
	}
	attempt, err := prepareTestInvite(t, s, c, invite.InviteID, token, strings.Repeat("5", 32))
	if err != nil {
		t.Fatal(err)
	}
	session, err := confirmTestInvite(t, s, c, attempt, strings.Repeat("5", 32), strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if session.Access.Role != "moderator" {
		t.Fatal("saved original role not restored")
	}
	if err = s.kick(ctx, admin.Token, admin.Access.ProfileID, strings.Repeat("6", 32)); err == nil {
		t.Fatal("administrator kicked before role removal")
	}
}

func TestMembershipControlRequiresBothDevicesAndPreservesIdentityRole(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	a, b := newTestMemberSigner(1), newTestMemberSigner(2)
	admin := bootstrapTestServer(t, s, a)
	bi := activateTestMember(t, s, b, "member")
	bs := loginTestMember(t, s, b)
	root := admin.Access.ProfileID
	if _, err := s.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)", bi.ProfileID, root, s.now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE memberships SET state='linked' WHERE profile_id=?", bi.ProfileID); err != nil {
		t.Fatal(err)
	}
	var server string
	s.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&server)
	request := strings.Repeat("7", 32)
	frame, _ := signatureFrame("pawtalk-control-v2", server, root, admin.Access.DeviceID, bi.DeviceID, "1", request)
	input := memberControlInput{NewDeviceID: bi.DeviceID, RequestID: request, ExpectedRevision: 1, OldSignature: b64.EncodeToString(ed25519.Sign(a.device, frame)), NewSignature: b64.EncodeToString(ed25519.Sign(a.device, frame))}
	if err := s.transferControl(ctx, admin.Token, input); err == nil {
		t.Fatal("control moved without new device's signature")
	}
	input.NewSignature = b64.EncodeToString(ed25519.Sign(b.device, frame))
	if err := s.transferControl(ctx, admin.Token, input); err != nil {
		t.Fatal(err)
	}
	state, err := s.state(ctx, bs.Token)
	if err != nil {
		t.Fatal(err)
	}
	if state.Self.EffectiveProfileID != root || state.Self.Role != "admin" {
		t.Fatal("control transfer changed canonical identity/role")
	}
	var main string
	s.db.QueryRow("SELECT primary_device_id FROM profile_controls WHERE profile_id=?", root).Scan(&main)
	if main != bi.DeviceID {
		t.Fatal("new main not stored")
	}
	if err = s.transferControl(ctx, admin.Token, input); err != nil {
		t.Fatal("lost successful response not retryable", err)
	}
	// Initial owner may detach after transferring control. It takes its own ID;
	// the remaining group takes the current main's ID but keeps group privileges.
	raw, _ := json.Marshal(map[string]string{"requestId": strings.Repeat("8", 32)})
	uri := "/api/v2/devices/" + admin.Access.DeviceID + "/unlink"
	proof := a.proof(t, s, "POST", uri, raw)
	if err = s.unlinkDevice(ctx, proof, "POST", uri, raw, admin.Access.DeviceID, strings.Repeat("8", 32), false); err != nil {
		t.Fatal(err)
	}
	state, err = s.state(ctx, bs.Token)
	if err != nil {
		t.Fatal(err)
	}
	if state.Self.EffectiveProfileID != bi.ProfileID || state.Self.Role != "admin" {
		t.Fatal("rebasing lost group identity or effective role")
	}
	var originalRole string
	s.db.QueryRow("SELECT role_id FROM profile_roles WHERE profile_id=?", bi.ProfileID).Scan(&originalRole)
	if originalRole != "member" {
		t.Fatal("rebasing overwrote original dormant role")
	}
	old, err := s.state(ctx, admin.Token)
	if err != nil || old.Self.EffectiveProfileID != root {
		t.Fatal("initial owner did not regain standalone profile", err)
	}
}
