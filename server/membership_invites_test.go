package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func prepareTestInvite(t *testing.T, s *membershipStore, k testMemberSigner, inviteID, token, request string) (memberPrepared, error) {
	t.Helper()
	input := memberPrepare{InviteID: inviteID, Token: token, RequestID: request, Nickname: "Test", DeviceLabel: "Test device"}
	raw, _ := json.Marshal(input)
	proof := k.proof(t, s, "POST", "/api/v2/invites/prepare", raw)
	return s.prepareInvite(context.Background(), proof, "POST", "/api/v2/invites/prepare", raw, input)
}
func confirmTestInvite(t *testing.T, s *membershipStore, k testMemberSigner, attempt memberPrepared, request, keyID string) (memberSession, error) {
	t.Helper()
	input := memberConfirm{AttemptID: attempt.AttemptID, RequestID: request, PackageDigest: attempt.PackageDigest, KeyID: keyID}
	raw, _ := json.Marshal(input)
	proof := k.proof(t, s, "POST", "/api/v2/invites/confirm", raw)
	return s.confirmInvite(context.Background(), proof, "POST", "/api/v2/invites/confirm", raw, input)
}
func bootstrapTestServer(t *testing.T, s *membershipStore, k testMemberSigner) memberSession {
	t.Helper()
	bootstrap, err := s.createBootstrap(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := prepareTestInvite(t, s, k, bootstrap.InviteID, bootstrap.Token, strings.Repeat("1", 32))
	if err != nil {
		t.Fatal(err)
	}
	session, err := confirmTestInvite(t, s, k, attempt, strings.Repeat("1", 32), strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if session.Access.Role != "admin" {
		t.Fatal("bootstrap did not grant administrator")
	}
	return session
}
func createTestInvite(t *testing.T, s *membershipStore, session, kind string, n int) (memberInviteCreate, string) {
	t.Helper()
	id := fmt.Sprintf("%032x", n+100)
	token, raw, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(raw)
	packet := memberInvitePackage{Version: 2, KeyID: strings.Repeat("a", 64), Nonce: b64.EncodeToString(make([]byte, 12)), Ciphertext: b64.EncodeToString(bytes.Repeat([]byte{1}, 32))}
	envelope, _ := json.Marshal(packet)
	digest := sha256.Sum256(envelope)
	input := memberInviteCreate{InviteID: id, TokenHash: hex.EncodeToString(hash[:]), Kind: kind, KeyPackage: envelope, PackageDigest: hex.EncodeToString(digest[:]), RequestID: fmt.Sprintf("%032x", n+1000)}
	if err = s.createInvite(context.Background(), session, input); err != nil {
		t.Fatal(err)
	}
	return input, token
}

func TestMembershipBootstrapPendingThenAtomicActivation(t *testing.T) {
	s := testMembershipStore(t)
	k := newTestMemberSigner(1)
	setup, err := s.createBootstrap(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := prepareTestInvite(t, s, k, setup.InviteID, setup.Token, strings.Repeat("1", 32))
	if err != nil {
		t.Fatal(err)
	}
	proof := k.proof(t, s, "POST", "/api/v2/session", []byte(`{}`))
	if _, err = s.session(context.Background(), proof, "POST", "/api/v2/session", []byte(`{}`)); err == nil {
		t.Fatal("pending device obtained member session")
	}
	var count int
	s.db.QueryRow("SELECT COUNT(*) FROM memberships").Scan(&count)
	if count != 0 {
		t.Fatal("pending identity added to roster")
	}
	session, err := confirmTestInvite(t, s, k, attempt, strings.Repeat("1", 32), strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if session.Access.Role != "admin" {
		t.Fatal("initial role not administrator")
	}
	if _, err = s.createBootstrap(context.Background()); err == nil {
		t.Fatal("second administrative bootstrap allowed")
	}
	replay, err := confirmTestInvite(t, s, k, attempt, strings.Repeat("1", 32), strings.Repeat("a", 64))
	if err != nil || replay.Access.ProfileID != session.Access.ProfileID {
		t.Fatal("lost confirm response cannot be retried", err)
	}
	if _, err = confirmTestInvite(t, s, k, attempt, strings.Repeat("1", 32), strings.Repeat("b", 64)); err == nil {
		t.Fatal("different key accepted on replay")
	}
	var uses int
	s.db.QueryRow("SELECT used_count FROM invites WHERE invite_id=?", setup.InviteID).Scan(&uses)
	if uses != 1 {
		t.Fatal("bootstrap consumed twice")
	}
}

func TestMembershipInviteTimeoutRequiresNewLink(t *testing.T) {
	s := testMembershipStore(t)
	clock := s.now()
	s.now = func() time.Time { return clock }
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	invite, token := createTestInvite(t, s, admin.Token, "single", 1)
	guest := newTestMemberSigner(2)
	attempt, err := prepareTestInvite(t, s, guest, invite.InviteID, token, strings.Repeat("2", 32))
	if err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(121 * time.Second)
	if _, err = confirmTestInvite(t, s, guest, attempt, strings.Repeat("2", 32), strings.Repeat("a", 64)); err == nil {
		t.Fatal("expired reservation confirmed")
	}
	if _, err = prepareTestInvite(t, s, guest, invite.InviteID, token, strings.Repeat("3", 32)); err == nil {
		t.Fatal("expired attempt reused old link")
	}
	var count int
	s.db.QueryRow("SELECT COUNT(*) FROM memberships").Scan(&count)
	if count != 1 {
		t.Fatal("expired guest retained membership")
	}
	fresh, freshToken := createTestInvite(t, s, admin.Token, "single", 2)
	attempt, err = prepareTestInvite(t, s, guest, fresh.InviteID, freshToken, strings.Repeat("4", 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = confirmTestInvite(t, s, guest, attempt, strings.Repeat("4", 32), strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
}

func TestMembershipSingleInviteReservationRace(t *testing.T) {
	s := testMembershipStore(t)
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	invite, token := createTestInvite(t, s, admin.Token, "single", 1)
	type prepared struct {
		p     membershipProof
		raw   []byte
		input memberPrepare
	}
	requests := []prepared{}
	for i := 2; i <= 3; i++ {
		k := newTestMemberSigner(byte(i))
		in := memberPrepare{InviteID: invite.InviteID, Token: token, RequestID: fmt.Sprintf("%032x", i), Nickname: "Test", DeviceLabel: "Test"}
		raw, _ := json.Marshal(in)
		requests = append(requests, prepared{k.proof(t, s, "POST", "/api/v2/invites/prepare", raw), raw, in})
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, request := range requests {
		wg.Add(1)
		go func(r prepared) {
			defer wg.Done()
			_, err := s.prepareInvite(context.Background(), r.p, "POST", "/api/v2/invites/prepare", r.raw, r.input)
			results <- err
		}(request)
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		}
	}
	if success != 1 {
		t.Fatalf("single-use invitation admitted %d reservations", success)
	}
}

func TestMembershipReusableTimeoutDoesNotRevokeOtherDevices(t *testing.T) {
	s := testMembershipStore(t)
	clock := s.now()
	s.now = func() time.Time { return clock }
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	invite, token := createTestInvite(t, s, admin.Token, "reusable", 1)
	failed := newTestMemberSigner(2)
	if _, err := prepareTestInvite(t, s, failed, invite.InviteID, token, strings.Repeat("2", 32)); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(121 * time.Second)
	if _, err := prepareTestInvite(t, s, failed, invite.InviteID, token, strings.Repeat("3", 32)); err == nil {
		t.Fatal("failed device retried same reusable invitation")
	}
	other := newTestMemberSigner(3)
	attempt, err := prepareTestInvite(t, s, other, invite.InviteID, token, strings.Repeat("4", 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = confirmTestInvite(t, s, other, attempt, strings.Repeat("4", 32), strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
}

func TestMembershipInviteCapsAndModeratorOwnership(t *testing.T) {
	s := testMembershipStore(t)
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	for i := 1; i <= 100; i++ {
		createTestInvite(t, s, admin.Token, "single", i)
	}
	input, _ := createTestInvite(t, s, admin.Token, "reusable", 101)
	extra := input
	extra.InviteID = strings.Repeat("f", 32)
	extra.RequestID = strings.Repeat("e", 32)
	extra.Kind = "single"
	// A unique token hash avoids mistaking an invite-ID collision for cap enforcement.
	h := sha256.Sum256([]byte("synthetic-extra-invite"))
	extra.TokenHash = hex.EncodeToString(h[:])
	if err := s.createInvite(context.Background(), admin.Token, extra); err == nil {
		t.Fatal("single invitation cap exceeded")
	}
	moderator := newTestMemberSigner(2)
	activateTestMember(t, s, moderator, "moderator")
	modSession := loginTestMember(t, s, moderator)
	if err := s.revokeInvite(context.Background(), modSession.Token, input.InviteID, strings.Repeat("d", 32)); err == nil {
		t.Fatal("moderator revoked another user's invitation")
	}
	own, _ := createTestInvite(t, s, modSession.Token, "reusable", 102)
	if err := s.revokeInvite(context.Background(), modSession.Token, own.InviteID, strings.Repeat("c", 32)); err != nil {
		t.Fatal(err)
	}
}
