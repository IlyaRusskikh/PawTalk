package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedImportedProfileCanReadmitAfterUnlink(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, membershipDatabaseFile)
	now := time.Unix(10000, 0)
	store, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	ownerKey, primaryKey, linkedKey := newTestMemberSigner(1), newTestMemberSigner(2), newTestMemberSigner(3)
	owner := bootstrapTestServer(t, store, ownerKey)
	primary := activateTestMember(t, store, primaryKey, "moderator")
	linked := activateTestMember(t, store, linkedKey, "admin")
	createdAt := now.UnixMilli()
	if _, err := store.db.Exec(`UPDATE memberships SET state='linked' WHERE profile_id=?`, linked.ProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)`,
		linked.ProfileID, primary.ProfileID, createdAt); err != nil {
		t.Fatal(err)
	}
	backup := copyMigrationDatabase(t, path)
	report, err := backup.prepare(ctx, path, now)
	if err != nil {
		t.Fatal(err)
	}
	migration := loadTestMigrationPolicyDraft(t, store)
	if migration.State == nil || !migration.State.ImportedProfileBindings || migration.State.ProfileBindings[linked.ProfileID] != primary.ProfileID ||
		migration.State.ProfileDeviceOrigins[linked.DeviceID] != linked.ProfileID {
		t.Fatalf("API 2 linked origin missing from migration state: %v", migration.Blockers)
	}
	// Import real frozen API 2 identities, then seed the signed genesis and
	// runtime session schema. The full cutover ceremony is covered separately.
	format := migrationPolicyFormat{}
	recipient := migrationRecipientReceipt{ReviewDigest: strings.Repeat("a", 64), DeviceID: owner.Access.DeviceID, PublicKey: testRecipientKey(t, 21)}
	initial, actor, err := migrationInitialState(migration, report.OwnerProfileID, recipient, format)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := previewMigrationInitialPolicy(migration, report.OwnerProfileID, recipient, format)
	if err != nil {
		t.Fatal(err)
	}
	draft := signTestPolicyDraft(t, store, owner, 1, preview.Draft)
	policy := access.NewStoreWithClock(store.db, store.now)
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	anchor, err := policy.InstallSignedInitialPolicy(ctx, tx, initial, actor, verifyProtectedPolicyDraft, draft)
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureProtectedSessionSchema(ctx, tx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	store.protectedBinding = strings.Repeat("d", 64)
	runtime := &protectedRuntime{store: store, serverID: report.ServerID, anchorDigest: anchor.Digest, cutoverDigest: strings.Repeat("c", 64),
		challenges: make(map[string]int64)}
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	call := func(method, path, token string, input any, status int, code string, output any) {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(ctx, method, room.URL+"/api/v3"+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := room.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status || (code != "" && !bytes.Contains(raw, []byte(`"`+code+`"`))) {
			if path == "/session/open" && response.StatusCode == http.StatusCreated {
				t.Fatalf("%s %s returned a session, want %d %s", method, path, status, code)
			}
			t.Fatalf("%s %s status %d, want %d %s: %s", method, path, response.StatusCode, status, code, raw)
		}
		if output != nil {
			if err := json.Unmarshal(raw, output); err != nil {
				t.Fatal(err)
			}
		}
	}
	signFrame := func(key ed25519.PrivateKey, fields ...string) string {
		t.Helper()
		frame, err := signatureFrame(fields...)
		if err != nil {
			t.Fatal(err)
		}
		return b64.EncodeToString(ed25519.Sign(key, frame))
	}
	open := func(key ed25519.PrivateKey, status int, code string) protectedSessionReceipt {
		t.Helper()
		device := publicKeyID(key.Public().(ed25519.PublicKey))
		var challenge struct{ Nonce string }
		call(http.MethodGet, "/session/challenge", "", nil, http.StatusOK, "", &challenge)
		proof := signFrame(key, "pawtalk-protected-session-v1", report.ServerID, runtime.cutoverDigest, store.protectedBinding, challenge.Nonce, device)
		var session protectedSessionReceipt
		call(http.MethodPost, "/session/open", "", protectedSessionRequest{DeviceID: device, Nonce: challenge.Nonce, Signature: proof}, status, code, &session)
		return session
	}
	assertFrozen := func() {
		t.Helper()
		var target, state string
		var created int64
		if err := store.db.QueryRow(`SELECT b.target_profile_id,b.created_at,m.state FROM profile_bindings b
			JOIN memberships m ON m.profile_id=b.source_profile_id WHERE b.source_profile_id=?`, linked.ProfileID).
			Scan(&target, &created, &state); err != nil || target != primary.ProfileID || created != createdAt || state != "linked" {
			t.Fatalf("frozen alias changed: target=%s created=%d state=%s error=%v", target, created, state, err)
		}
	}
	ownerSession := open(ownerKey.device, http.StatusCreated, "")
	primarySession := open(primaryKey.device, http.StatusCreated, "")
	linkedSession := open(linkedKey.device, http.StatusCreated, "")
	if linkedSession.ProfileID != primary.ProfileID || linkedSession.DeviceID != linked.DeviceID {
		t.Fatal("imported linked device did not open a session as the primary profile")
	}
	var projection access.Projection
	call(http.MethodGet, "/state", linkedSession.Token, nil, http.StatusOK, "", &projection)
	if !projection.CanListInvites {
		t.Fatal("imported linked device did not receive the primary profile's effective grants")
	}
	var links access.ProfileLinkStatus
	call(http.MethodGet, "/profiles/link/status", primarySession.Token, nil, http.StatusOK, "", &links)
	if !slices.Equal(links.Sources, []string{linked.ProfileID}) || links.PolicyHead != anchor.Digest {
		t.Fatalf("runtime link status did not use imported signed origins: %+v", links)
	}
	assertFrozen()
	capability := newTestMemberSigner(9).device
	uses := int64(1)
	invite := access.InviteCreate{ID: strings.Repeat("2", 32), TokenHash: publicKeyID(capability.Public().(ed25519.PublicKey)),
		PolicyDigest: anchor.Digest, MaxUses: &uses}
	inviteSignature, err := protectedInvitationFrame(report.ServerID, actor, invite, uses)
	if err != nil {
		t.Fatal(err)
	}
	invite.Signature = ed25519.Sign(ownerKey.device, inviteSignature)
	call(http.MethodPost, "/invites", ownerSession.Token, invite, http.StatusOK, "", nil)
	claim := access.InviteRedeem{InviteID: invite.ID, OperationID: strings.Repeat("3", 32), Nickname: "Returning member",
		InvitePublicKey: b64.EncodeToString(capability.Public().(ed25519.PublicKey)), ProfilePublicKey: b64.EncodeToString(linkedKey.root.Public().(ed25519.PublicKey)),
		DevicePublicKey: b64.EncodeToString(linkedKey.device.Public().(ed25519.PublicKey)), AgreementKey: testRecipientKey(t, 42)}
	inviteFrame, err := protectedInviteRedemptionFrame(report.ServerID, runtime.cutoverDigest, claim)
	if err != nil {
		t.Fatal(err)
	}
	claim.InviteSignature = b64.EncodeToString(ed25519.Sign(capability, inviteFrame))
	claim.ProfileSignature = b64.EncodeToString(ed25519.Sign(linkedKey.root, inviteFrame))
	claim.DeviceSignature = b64.EncodeToString(ed25519.Sign(linkedKey.device, inviteFrame))
	call(http.MethodPost, "/invites/redeem", "", claim, http.StatusConflict, "PROTECTED_INVITE_CONFLICT", nil)
	unlink := protectedProfileUnlinkApplyRequest{OperationID: strings.Repeat("4", 32), PolicyHead: links.PolicyHead, Source: linked.ProfileID,
		ExpiresAt: now.Add(5 * time.Minute).UnixMilli()}
	unlink.Proof = signFrame(primaryKey.device, "pawtalk-protected-profile-unlink-consent-v1", report.ServerID, runtime.cutoverDigest,
		unlink.PolicyHead, unlink.OperationID, primary.ProfileID, primary.DeviceID, unlink.Source, strconv.FormatInt(unlink.ExpiresAt, 10))
	call(http.MethodPost, "/profiles/unlink/apply", primarySession.Token, unlink, http.StatusOK, "", nil)
	call(http.MethodGet, "/state", linkedSession.Token, nil, http.StatusUnauthorized, "INVALID_PROTECTED_SESSION", nil)
	open(linkedKey.device, http.StatusForbidden, "PROTECTED_PROFILE_UNLINKED")
	call(http.MethodGet, "/state", primarySession.Token, nil, http.StatusOK, "", nil)
	assertFrozen()
	var receipt access.InviteAdmission
	call(http.MethodPost, "/invites/redeem", "", claim, http.StatusOK, "", &receipt)
	admitted := open(linkedKey.device, http.StatusCreated, "")
	if receipt.ProfileID != linked.ProfileID || admitted.ProfileID != linked.ProfileID || admitted.DeviceID != linked.DeviceID || receipt.Existing {
		t.Fatal("readmission did not create a fresh member for the original profile")
	}
	call(http.MethodGet, "/state", linkedSession.Token, nil, http.StatusUnauthorized, "INVALID_PROTECTED_SESSION", nil)
	var readmittedProjection access.Projection
	call(http.MethodGet, "/state", admitted.Token, nil, http.StatusOK, "", &readmittedProjection)
	state, _, err := policy.Snapshot(ctx)
	if err != nil || readmittedProjection.CanListInvites || readmittedProjection.CanManageBans ||
		!state.ImportedProfileBindings || state.ProfileBindings[linked.ProfileID] != "" || state.ProfileDeviceOrigins[linked.DeviceID] != "" ||
		!state.Members[linked.ProfileID].Active || len(state.Members[linked.ProfileID].Roles) != 0 ||
		state.KeyRecipients[linked.DeviceID] != (access.KeyRecipient{ProfileID: linked.ProfileID, Kind: "device", PublicKey: claim.AgreementKey}) {
		t.Fatalf("readmitted profile did not get baseline access and its own agreement key: %v", err)
	}
	assertFrozen()
	var usesAfter int
	if err := store.db.QueryRow(`SELECT uses FROM protected_invites WHERE id=?`, invite.ID).Scan(&usesAfter); err != nil || usesAfter != 1 {
		t.Fatalf("rejected alias redemption consumed an invitation use: count=%d error=%v", usesAfter, err)
	}
	replay, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer replay.Rollback()
	if err := access.VerifyActivatedPolicyChain(ctx, replay, anchor.Digest, actor, verifyProtectedPolicyForActivation); err != nil {
		t.Fatalf("signed imported origin, unlink and readmission did not replay: %v", err)
	}
}
