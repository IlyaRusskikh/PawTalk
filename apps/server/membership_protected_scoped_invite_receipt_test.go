package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedScopedInviteReceipt(t *testing.T) {
	version := access.TextRoleViewDenyProjectionVersion
	if access.HasTextRecipientProjection(access.TextNewcomerAdmissionProjectionVersion) {
		version = access.TextNewcomerAdmissionProjectionVersion
	}
	ctx := context.Background()
	now := time.Date(2026, 4, 1, 12, 0, 0, 0, time.UTC)
	dbPath := filepath.Join(t.TempDir(), "protected-invites.sqlite")
	server, err := openMembershipDatabase(dbPath, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	initialDB := server.db
	t.Cleanup(func() { initialDB.Close() })
	store, _, owner, _ := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles[access.Everyone] = access.Role{Grants: []string{access.ChannelView}}
	})
	var serverID string
	var serverKey []byte
	if err := server.db.QueryRow(`SELECT server_id,identity_public_key FROM server_state WHERE id=1`).Scan(&serverID, &serverKey); err != nil {
		t.Fatal(err)
	}
	draft, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{Action: access.AnchorPolicy,
		OperationID: strings.Repeat("a", 32), TextProjectionSeed: strings.Repeat("b", 64),
		TextProjectionVersion: version})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, draft))
	if err != nil {
		t.Fatal(err)
	}
	if receipt, err := access.ReadScopedInviteReceipt(ctx, server.db, anchor.Digest); err != nil || receipt != nil {
		t.Fatalf("anchor has unexpected receipt: %v, %v", receipt != nil, err)
	}
	maxUses := int64(1)
	if version == access.TextNewcomerAdmissionProjectionVersion {
		maxUses = 2
	}
	issuer := access.Principal{ProfileID: owner.Access.EffectiveProfileID, DeviceID: owner.Access.DeviceID}
	expiresAt := now.Add(time.Hour)
	issueLink := func(id string, seed byte, uses int64) (access.InviteCreate, ed25519.PrivateKey) {
		t.Helper()
		key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, ed25519.SeedSize))
		input := access.InviteCreate{ID: id, TokenHash: publicKeyID(key.Public().(ed25519.PublicKey)),
			PolicyDigest: anchor.Digest, MaxUses: &uses, ExpiresAt: expiresAt.UnixMilli()}
		frame, err := protectedInvitationFrame(serverID, issuer, input, uses)
		if err != nil {
			t.Fatal(err)
		}
		input.Signature = ed25519.Sign(newTestMemberSigner(1).device, frame)
		if _, err := store.CreateInvite(ctx, server.protectedSession(owner.Token), verifyProtectedInvitation, input); err != nil {
			t.Fatal(err)
		}
		return input, key
	}
	issue, capability := issueLink(strings.Repeat("c", 32), 19, maxUses)
	unlimited, unlimitedKey := issueLink(strings.Repeat("d", 32), 20, 0)
	cutover := strings.Repeat("d", 64)
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: cutover, anchorDigest: anchor.Digest}
	signedClaim := func(invite access.InviteCreate, key ed25519.PrivateKey, operation string, seed byte) access.InviteRedeem {
		t.Helper()
		applicant := newTestMemberSigner(seed)
		claim := access.InviteRedeem{InviteID: invite.ID, OperationID: operation, Nickname: "Synthetic <guest>",
			InvitePublicKey:  b64.EncodeToString(key.Public().(ed25519.PublicKey)),
			ProfilePublicKey: b64.EncodeToString(applicant.root.Public().(ed25519.PublicKey)),
			DevicePublicKey:  b64.EncodeToString(applicant.device.Public().(ed25519.PublicKey)),
			AgreementKey:     testRecipientKey(t, seed)}
		frame, err := protectedInviteRedemptionFrame(serverID, cutover, claim)
		if err != nil {
			t.Fatal(err)
		}
		claim.InviteSignature = b64.EncodeToString(ed25519.Sign(key, frame))
		claim.ProfileSignature = b64.EncodeToString(ed25519.Sign(applicant.root, frame))
		claim.DeviceSignature = b64.EncodeToString(ed25519.Sign(applicant.device, frame))
		return claim
	}
	claim := signedClaim(issue, capability, strings.Repeat("e", 32), 29)
	if version == access.TextNewcomerAdmissionProjectionVersion {
		interrupted := errors.New("synthetic compact signature failure")
		if _, err := store.RedeemInvite(ctx, claim, runtime.verifyInviteApplicant, verifyProtectedInvitationSignature,
			verifyProtectedPolicyDraft, &access.InviteEnrollment{CutoverDigest: cutover, ServerKey: b64.EncodeToString(serverKey),
				Sign: signProtectedServerPolicy, SignReceipt: func(context.Context, access.SessionQuery, access.ScopedInviteReceipt) ([]byte, error) {
					return nil, interrupted
				}}); !errors.Is(err, interrupted) {
			t.Fatalf("expected injected signing failure, got %v", err)
		}
		if head, err := access.ReadPolicyHead(ctx, server.db, nil); err != nil || head.Digest != anchor.Digest {
			t.Fatalf("failed receipt changed policy: %v", err)
		}
	}

	startTLS := func(runtime *protectedRuntime) *httptest.Server {
		t.Helper()
		room := httptest.NewTLSServer(runtime.handler())
		room.Client().Timeout = 15 * time.Second
		t.Cleanup(room.Close)
		return room
	}
	room := startTLS(runtime)
	type redemption struct {
		receipt access.InviteAdmission
		status  int
		code    string
		err     error
	}
	request := func(room *httptest.Server, candidate access.InviteRedeem) (outcome redemption) {
		body, err := json.Marshal(candidate)
		if err != nil {
			outcome.err = err
			return outcome
		}
		response, err := room.Client().Post(room.URL+"/api/v3/invites/redeem", "application/json", bytes.NewReader(body))
		if err != nil {
			outcome.err = err
			return outcome
		}
		defer response.Body.Close()
		outcome.status = response.StatusCode
		if outcome.status == http.StatusOK {
			outcome.err = json.NewDecoder(response.Body).Decode(&outcome.receipt)
		} else {
			var rejected struct{ Error struct{ Code string } }
			outcome.err = json.NewDecoder(response.Body).Decode(&rejected)
			outcome.code = rejected.Error.Code
		}
		return outcome
	}
	redeem := func(candidate access.InviteRedeem) access.InviteAdmission {
		t.Helper()
		outcome := request(room, candidate)
		if outcome.status != http.StatusOK || outcome.err != nil {
			t.Fatalf("could not redeem invitation: %+v", outcome)
		}
		return outcome.receipt
	}
	first := redeem(claim)
	if first.Existing || !first.KeysPending {
		t.Fatalf("failed signing left stale admission: %+v", first)
	}
	head, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := access.ReadScopedInviteReceipt(ctx, server.db, head.Digest)
	if version == access.TextRoleViewDenyProjectionVersion {
		if err != nil || receipt != nil || head.Draft.TextProjectionVersion != version || head.Draft.Action != access.RedeemPolicyInvite {
			t.Fatalf("legacy redemption changed compact receipt behavior: %v, %v", receipt != nil, err)
		}
		return
	}
	if err != nil || receipt == nil {
		t.Fatalf("missing scoped receipt: %v", err)
	}
	if receipt.Digest != head.Digest || receipt.Revision != anchor.Draft.Revision+1 || receipt.PreviousDigest != anchor.Digest ||
		receipt.ResultDigest != head.Draft.ResultDigest || receipt.ProjectionRoot != head.Draft.TextProjectionRoot || receipt.OperationID != head.Draft.OperationID ||
		receipt.Actor != (access.Principal{ProfileID: first.ProfileID, DeviceID: first.DeviceID}) ||
		!reflect.DeepEqual(receipt.Admission, *head.Draft.ResourceChange.Admission) || receipt.Admission.Claim != claim {
		t.Fatal("compact receipt did not bind the accepted admission and exact policy")
	}
	frame, err := access.ScopedInviteReceiptFrame(serverID, *receipt)
	if err != nil || !ed25519.Verify(serverKey, frame, receipt.Signature) || bytes.Equal(receipt.Signature, head.Draft.Signature) {
		t.Fatal("receipt lacks its separate server signature")
	}
	wire, err := json.Marshal(receipt)
	if err != nil || head.Draft.TextProjectionSeed == "" || bytes.Contains(wire, []byte(head.Draft.TextProjectionSeed)) ||
		bytes.Contains(wire, []byte("TextProjectionSeed")) {
		t.Fatal("compact receipt contains a private draft field")
	}
	if retry := redeem(claim); !retry.Existing || retry.DeviceID != first.DeviceID || retry.AcceptedAt != first.AcceptedAt {
		t.Fatalf("admission retry changed receipt: %+v", retry)
	}
	if replay, err := access.ReadScopedInviteReceipt(ctx, server.db, head.Digest); err != nil || !reflect.DeepEqual(replay, receipt) {
		t.Fatalf("receipt changed on retry: %v", err)
	}
	var uses int
	if err := server.db.QueryRow(`SELECT uses FROM protected_invites WHERE id=?`, issue.ID).Scan(&uses); err != nil || uses != 1 {
		t.Fatalf("receipt failure or retry consumed another invite use: %d %v", uses, err)
	}
	contenders := []access.InviteRedeem{
		signedClaim(issue, capability, strings.Repeat("f", 32), 30),
		signedClaim(issue, capability, strings.Repeat("1", 32), 31),
	}
	ready := make(chan int, len(contenders))
	outcomes := make([]redemption, len(contenders))
	for i, contender := range contenders {
		go func() {
			outcomes[i] = request(room, contender)
			ready <- i
		}()
	}
	<-ready
	<-ready
	winner, loser := 0, 1
	if outcomes[1].status == http.StatusOK {
		winner, loser = 1, 0
	}
	assertUnavailable := func(outcome redemption) {
		t.Helper()
		if outcome.err != nil || outcome.status != http.StatusGone || outcome.code != "PROTECTED_INVITE_UNAVAILABLE" {
			t.Fatalf("unavailable invitation was not rejected uniformly: %+v", outcome)
		}
	}
	if outcomes[winner].err != nil || outcomes[winner].status != http.StatusOK {
		t.Fatalf("no winner at the last remaining use: %+v", outcomes)
	}
	assertUnavailable(outcomes[loser])
	secondClaim, second := contenders[winner], outcomes[winner].receipt
	if second.Existing || !second.KeysPending || second.DeviceID == first.DeviceID {
		t.Fatalf("unexpected second admission: %+v", second)
	}
	latest, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	chain, err := access.ReadScopedInviteReceiptChain(ctx, server.db, anchor, latest)
	if err != nil || len(chain) != 2 || chain[0].Digest != head.Digest || chain[1].Digest != latest.Digest ||
		chain[1].PreviousDigest != head.Digest || chain[1].Admission.Claim != secondClaim {
		t.Fatalf("admission suffix did not match accepted receipts: length %d, %v", len(chain), err)
	}
	if err := server.db.QueryRow(`SELECT uses FROM protected_invites WHERE id=?`, issue.ID).Scan(&uses); err != nil || uses != 2 {
		t.Fatalf("reusable invite did not consume exactly two uses: %d %v", uses, err)
	}

	unlimitedFirstClaim := signedClaim(unlimited, unlimitedKey, strings.Repeat("2", 32), 32)
	unlimitedFirst := redeem(unlimitedFirstClaim)
	unlimitedSecond := redeem(signedClaim(unlimited, unlimitedKey, strings.Repeat("3", 32), 33))
	expiringHead, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	room.Close()
	if err := server.db.Close(); err != nil {
		t.Fatal(err)
	}
	now = expiresAt.Add(time.Second)
	db, err := openMigrationImportDatabase(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	server = &membershipStore{db: db, now: server.now, maxBytes: server.maxBytes}
	runtime = &protectedRuntime{store: server, serverID: serverID, cutoverDigest: cutover, anchorDigest: anchor.Digest}
	room = startTLS(runtime)
	assertUnavailable(request(room, signedClaim(unlimited, unlimitedKey, strings.Repeat("4", 32), 34)))
	for _, existing := range []struct {
		claim   access.InviteRedeem
		receipt access.InviteAdmission
	}{{claim, first}, {secondClaim, second}, {unlimitedFirstClaim, unlimitedFirst}} {
		retried := redeem(existing.claim)
		if !retried.Existing {
			t.Fatal("previously accepted operation was repeated after reopening")
		}
		retried.Existing = false
		if retried != existing.receipt {
			t.Fatalf("accepted receipt changed after reopening and expiry: %+v", retried)
		}
	}
	final, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil || final.Digest != expiringHead.Digest {
		t.Fatalf("expired redemption or accepted retry changed the signed head: %v", err)
	}
	snapshot, _, err := access.NewStoreWithClock(server.db, server.now).Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range []access.InviteAdmission{first, second, unlimitedFirst, unlimitedSecond} {
		if current := snapshot.Members[member.ProfileID]; !current.Active || len(current.Roles) != 0 ||
			snapshot.KeyRecipients[member.DeviceID].ProfileID != member.ProfileID {
			t.Fatalf("last-use race, expiry, or reopen changed admitted membership: %+v", current)
		}
	}
	for _, invite := range []access.InviteCreate{issue, unlimited} {
		var persistedUses int
		if err := server.db.QueryRow(`SELECT uses FROM protected_invites WHERE id=?`, invite.ID).Scan(&persistedUses); err != nil ||
			persistedUses != 2 || snapshot.InvitationUses[invite.ID].Count != 2 {
			t.Fatalf("use counts differ after reopen: %d / %d, %v", persistedUses, snapshot.InvitationUses[invite.ID].Count, err)
		}
	}
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	replayErr := access.VerifyActivatedPolicyChain(ctx, tx, anchor.Digest, anchor.Principal, verifyProtectedPolicyDraft)
	if err := tx.Rollback(); replayErr != nil || err != nil {
		t.Fatalf("startup verifier rejected persisted admissions: %v / %v", replayErr, err)
	}
	if chain, err := access.ReadScopedInviteReceiptChain(ctx, server.db, anchor, final); err != nil || len(chain) != 4 {
		t.Fatalf("persisted scoped receipt chain did not include the four admissions: %d, %v", len(chain), err)
	}

	for _, mutate := range []func(*access.ScopedInviteReceipt){
		func(value *access.ScopedInviteReceipt) { value.Admission.Claim.Nickname = "Modified guest" },
		func(value *access.ScopedInviteReceipt) { value.ProjectionRoot = strings.Repeat("0", 64) },
	} {
		changed := *receipt
		mutate(&changed)
		modified, err := json.Marshal(changed)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := server.db.Exec(`UPDATE protected_scoped_invite_receipts SET record=? WHERE successor_digest=?`, modified, head.Digest); err != nil {
			t.Fatal(err)
		}
		if got, err := access.ReadScopedInviteReceipt(ctx, server.db, head.Digest); got != nil || !errors.Is(err, access.ErrPolicyConflict) {
			t.Fatalf("reader returned altered signed receipt: %v, %v", got != nil, err)
		}
		if got, err := access.ReadScopedInviteReceiptChain(ctx, server.db, anchor, latest); got != nil || !errors.Is(err, access.ErrPolicyConflict) {
			t.Fatalf("suffix accepted altered intermediate receipt: %d, %v", len(got), err)
		}
	}
	if _, err := server.db.Exec(`DELETE FROM protected_scoped_invite_receipts WHERE successor_digest=?`, head.Digest); err != nil {
		t.Fatal(err)
	}
	if got, err := access.ReadScopedInviteReceiptChain(ctx, server.db, anchor, latest); got != nil || err != nil {
		t.Fatalf("suffix crossed a missing receipt: %d, %v", len(got), err)
	}
}
