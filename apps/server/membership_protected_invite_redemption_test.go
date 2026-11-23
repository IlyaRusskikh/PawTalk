package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

type inviteResponseRecorder struct{ *httptest.ResponseRecorder }

func (inviteResponseRecorder) SetWriteDeadline(time.Time) error { return nil }

func TestProtectedInviteRedemptionBindsIdentityAndConsumesOnce(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	store, initial, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles[access.Everyone] = access.Role{Grants: []string{access.ChannelView}}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.send", "history.full", "invite.create"}}
	})
	preview, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("a", 32)})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, preview))
	if err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := server.db.QueryRow(`SELECT server_id FROM server_state WHERE id=1`).Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	oldSessionSchema := strings.Replace(protectedSessionSchema, "device_id TEXT NOT NULL,", "device_id TEXT NOT NULL REFERENCES devices(device_id),", 1)
	if _, err := server.db.ExecContext(ctx, oldSessionSchema); err != nil {
		t.Fatal(err)
	}
	upgrade, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer upgrade.Rollback()
	if err := ensureProtectedSessionSchema(ctx, upgrade); err != nil {
		t.Fatal(err)
	}
	if err := upgrade.Commit(); err != nil {
		t.Fatal(err)
	}
	runtime := &protectedRuntime{store: &membershipStore{db: server.db, now: server.now, protectedBinding: strings.Repeat("d", 64)},
		serverID: serverID, cutoverDigest: strings.Repeat("c", 64), challenges: make(map[string]int64)}
	handler := runtime.handler()
	issue := func(id string, maxUses int64, author memberSession, seed byte) (access.InviteCreate, ed25519.PrivateKey) {
		t.Helper()
		public, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		head, err := access.ReadPolicyHead(ctx, server.db, nil)
		if err != nil {
			t.Fatal(err)
		}
		input := access.InviteCreate{ID: id, TokenHash: publicKeyID(public), PolicyDigest: head.Digest, MaxUses: &maxUses}
		actor := access.Principal{ProfileID: author.Access.EffectiveProfileID, DeviceID: author.Access.DeviceID}
		frame, err := protectedInvitationFrame(serverID, actor, input, maxUses)
		if err != nil {
			t.Fatal(err)
		}
		input.Signature = ed25519.Sign(newTestMemberSigner(seed).device, frame)
		if _, err := store.CreateInvite(ctx, server.protectedSession(author.Token), verifyProtectedInvitation, input); err != nil {
			t.Fatal(err)
		}
		return input, key
	}
	claim := func(invite access.InviteCreate, capability ed25519.PrivateKey, operation string, seed byte) access.InviteRedeem {
		t.Helper()
		identity := newTestMemberSigner(seed)
		input := access.InviteRedeem{InviteID: invite.ID, OperationID: operation, Nickname: "Synthetic applicant",
			InvitePublicKey:  b64.EncodeToString(capability.Public().(ed25519.PublicKey)),
			ProfilePublicKey: b64.EncodeToString(identity.root.Public().(ed25519.PublicKey)),
			DevicePublicKey:  b64.EncodeToString(identity.device.Public().(ed25519.PublicKey)), AgreementKey: testRecipientKey(t, seed)}
		frame, err := protectedInviteRedemptionFrame(serverID, runtime.cutoverDigest, input)
		if err != nil {
			t.Fatal(err)
		}
		input.ProfileSignature = b64.EncodeToString(ed25519.Sign(identity.root, frame))
		input.DeviceSignature = b64.EncodeToString(ed25519.Sign(identity.device, frame))
		input.InviteSignature = b64.EncodeToString(ed25519.Sign(capability, frame))
		return input
	}
	request := func(input access.InviteRedeem) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		// Exercise compatibility with receipts committed before atomic enrollment.
		result, err := store.RedeemInvite(ctx, input, runtime.verifyInviteApplicant, verifyProtectedInvitationSignature,
			verifyProtectedPolicyDraft, nil)
		if err != nil {
			protectedPolicyFail(w, err)
		} else {
			respond(w, http.StatusOK, result)
		}
		return w
	}
	first, capability := issue(strings.Repeat("1", 32), 1, owner, 1)
	claims := []access.InviteRedeem{
		claim(first, capability, strings.Repeat("2", 32), 10), claim(first, capability, strings.Repeat("3", 32), 11),
	}
	tampered := claims[0]
	tampered.AgreementKey = testRecipientKey(t, 99)
	if w := request(tampered); w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "INVALID_PROTECTED_INVITE_PROOF") {
		t.Fatalf("accepted substituted agreement key: %d %s", w.Code, w.Body.String())
	}
	responses := [2]*httptest.ResponseRecorder{}
	done := make(chan int, 2)
	for i := range claims {
		go func() {
			responses[i] = request(claims[i])
			done <- i
		}()
	}
	<-done
	<-done
	winner, loser := 0, 1
	if responses[0].Code == http.StatusGone {
		winner, loser = 1, 0
	}
	if responses[winner].Code != http.StatusOK || responses[loser].Code != http.StatusGone ||
		!strings.Contains(responses[loser].Body.String(), "PROTECTED_INVITE_UNAVAILABLE") {
		t.Fatalf("one-use race: %d %s / %d %s", responses[0].Code, responses[0].Body.String(), responses[1].Code, responses[1].Body.String())
	}
	var receipt, replay access.InviteAdmission
	if err := json.Unmarshal(responses[winner].Body.Bytes(), &receipt); err != nil || receipt.Existing || !receipt.KeysPending {
		t.Fatalf("initial admission: %+v %v", receipt, err)
	}
	if w := request(claims[winner]); w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &replay) != nil || !replay.Existing {
		t.Fatalf("admission retry: %d %s", w.Code, w.Body.String())
	}
	replay.Existing = false
	if replay != receipt {
		t.Fatalf("retry did not preserve accepted identity: %+v != %+v", replay, receipt)
	}
	var count int
	if err := server.db.QueryRow(`SELECT uses FROM protected_invites WHERE id=?`, first.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("admission did not consume exactly one use: %d %v", count, err)
	}
	var snapshot []byte
	if err := server.db.QueryRow(`SELECT snapshot FROM protected_policy WHERE id=1`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	var state access.State
	if err := json.Unmarshal(snapshot, &state); err != nil || state.Members[receipt.ProfileID].Active || state.KeyRecipients[receipt.DeviceID].Kind != "" {
		t.Fatalf("admission implicitly enrolled signed policy or keys: %v", err)
	}
	second, secondKey := issue(strings.Repeat("4", 32), 2, reader, 2)
	initial.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.send", "history.full"}}
	rolePreview, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{Action: access.UpdatePolicyRoles,
		OperationID: strings.Repeat("b", 32), RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, rolePreview)); err != nil {
		t.Fatal(err)
	}
	accepted := claim(second, secondKey, strings.Repeat("5", 32), 12)
	if w := request(accepted); w.Code != http.StatusOK {
		t.Fatalf("multi-use invitation: %d %s", w.Code, w.Body.String())
	}
	if err := store.RevokeInvite(ctx, server.protectedSession(owner.Token), second.ID); err != nil {
		t.Fatal(err)
	}
	if w := request(claim(second, secondKey, strings.Repeat("6", 32), 13)); w.Code != http.StatusGone {
		t.Fatalf("revoked invitation admitted a profile: %d %s", w.Code, w.Body.String())
	}
	if w := request(accepted); w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &replay) != nil || !replay.Existing {
		t.Fatalf("revocation canceled an already accepted admission: %d %s", w.Code, w.Body.String())
	}
	challenge, err := runtime.issueSessionChallenge()
	if err != nil {
		t.Fatal(err)
	}
	frame, err := protectedPendingSessionFrame(serverID, runtime.cutoverDigest, runtime.store.protectedBinding, challenge.Nonce, replay.ProfileID, replay.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	proof := protectedSessionRequest{DeviceID: replay.DeviceID, Nonce: challenge.Nonce,
		Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(12).device, frame))}
	if _, err := runtime.openSession(ctx, proof); err == nil {
		t.Fatal("pending proof opened an ordinary protected session")
	}
	pending, err := runtime.openPendingInviteSession(ctx, proof)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.openPendingInviteSession(ctx, proof); err == nil {
		t.Fatal("accepted replay of the pending challenge")
	}
	get := func(path, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.TLS = &tls.ConnectionState{}
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(inviteResponseRecorder{w}, r)
		return w
	}
	const pendingStatePath = "/api/v3/invites/session/state"
	var status access.PendingInviteAdmission
	if w := get(pendingStatePath, pending.Token); w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &status) != nil || status.ProfileID != replay.ProfileID ||
		!status.KeysPending || status.Nickname != accepted.Nickname || strings.Contains(w.Body.String(), accepted.InviteSignature) {
		t.Fatalf("pending state: %d %s", w.Code, w.Body.String())
	}
	if w := get("/api/v3/state", pending.Token); w.Code != http.StatusUnauthorized {
		t.Fatalf("pending token obtained ordinary channel state: %d %s", w.Code, w.Body.String())
	}
	sessionProof := func(seed byte) protectedSessionRequest {
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, challenge.CutoverDigest, challenge.Binding, challenge.Nonce, replay.DeviceID)
		if err != nil {
			t.Fatal(err)
		}
		return protectedSessionRequest{DeviceID: replay.DeviceID, Nonce: challenge.Nonce,
			Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))}
	}
	checkSessionDenied := func(status int, code string) {
		t.Helper()
		var rejected *membershipError
		if _, err := runtime.openSession(ctx, sessionProof(12)); !errors.As(err, &rejected) ||
			rejected.Status != status || rejected.Code != code {
			t.Fatalf("ordinary session must fail with %s: %v", code, err)
		}
	}
	checkSessionDenied(http.StatusUnauthorized, "INVALID_PROTECTED_SESSION_PROOF")
	var digest string
	if err := server.db.QueryRow(`SELECT request_digest FROM protected_invite_admissions WHERE device_id=?`, replay.DeviceID).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.Exec(`UPDATE protected_invite_admissions SET request_digest=? WHERE device_id=?`, strings.Repeat("0", 64), replay.DeviceID); err != nil {
		t.Fatal(err)
	}
	if w := get(pendingStatePath, pending.Token); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "PROTECTED_INVITE_CONFLICT") {
		t.Fatalf("pending session trusted a modified admission: %d %s", w.Code, w.Body.String())
	}
	if _, err := server.db.Exec(`UPDATE protected_invite_admissions SET request_digest=? WHERE device_id=?`, digest, replay.DeviceID); err != nil {
		t.Fatal(err)
	}
	evidenceTx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer evidenceTx.Rollback()
	witness, err := runtime.readPendingAdmission(ctx, evidenceTx, replay.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	if err := evidenceTx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if witness.Issuance.PolicyRevision != 1 || witness.Issuance.PolicyDigest != anchor.Digest ||
		witness.Issuance.Issuer.ProfileID != reader.Access.EffectiveProfileID || witness.Issuance.Issuer.DeviceID != reader.Access.DeviceID ||
		witness.Issuance.MaxUses != 2 || witness.Issuance.AcceptedAt != replay.AcceptedAt {
		t.Fatalf("incorrect issuance evidence: %+v", witness.Issuance)
	}
	proposal := access.PolicyDraft{Action: access.AdmitInviteMember, OperationID: strings.Repeat("7", 32),
		ResourceChange: &access.PolicyResourceChange{ID: replay.ProfileID,
			Admission: &access.InvitePolicyAdmission{CutoverDigest: runtime.cutoverDigest, Claim: accepted, Issuance: &witness.Issuance}}}
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, proposal); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("unauthorized admission preview: %v", err)
	}
	unsigned, err := server.previewProtectedPolicy(ctx, owner.Token, proposal)
	if err != nil {
		t.Fatal(err)
	}
	signed := signTestPolicyDraft(t, server, owner, 1, unsigned)
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, signed); !errors.Is(err, access.InvalidAction) {
		t.Fatalf("ordinary policy commit bypassed invitation receipt verification: %v", err)
	}
	apply := func(draft access.PolicyDraft) (access.PolicyProof, error) {
		return store.CommitInviteAdmissionPolicy(ctx, server.protectedSession(owner.Token), verifyProtectedPolicyDraft, draft, runtime.confirmInviteAdmission)
	}
	forgedClaim := claim(second, secondKey, strings.Repeat("8", 32), 12)
	unaccepted := proposal
	unaccepted.ResourceChange = &access.PolicyResourceChange{ID: replay.ProfileID,
		Admission: &access.InvitePolicyAdmission{CutoverDigest: runtime.cutoverDigest, Claim: forgedClaim, Issuance: &witness.Issuance}}
	unacceptedDraft, err := server.previewProtectedPolicy(ctx, owner.Token, unaccepted)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := apply(signTestPolicyDraft(t, server, owner, 1, unacceptedDraft)); !errors.Is(err, access.ErrInviteConflict) {
		t.Fatalf("signed claim without matching receipt committed: %v", err)
	}
	forgedTime := witness.Issuance
	forgedTime.AcceptedAt++
	unaccepted.ResourceChange.Admission.Claim = accepted
	unaccepted.ResourceChange.Admission.Issuance = &forgedTime
	unacceptedDraft, err = server.previewProtectedPolicy(ctx, owner.Token, unaccepted)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := apply(signTestPolicyDraft(t, server, owner, 1, unacceptedDraft)); !errors.Is(err, access.ErrInviteConflict) {
		t.Fatalf("substituted acceptance time committed: %v", err)
	}
	enrolled, err := apply(signed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := apply(signed); !errors.Is(err, access.ErrInviteConflict) {
		t.Fatalf("duplicate enrollment changed policy: %v", err)
	}
	page, err := store.PolicyProofPage(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	state = access.State{}
	if len(page.Proofs) != 3 {
		t.Fatalf("expected three policy proofs, got %d", len(page.Proofs))
	}
	if err := json.Unmarshal(page.Proofs[2].Snapshot, &state); err != nil {
		t.Fatal(err)
	}
	member, device, recipient := state.Members[replay.ProfileID], state.PolicyDevices[replay.DeviceID], state.KeyRecipients[replay.DeviceID]
	if enrolled.Draft.Revision != 3 || !member.Active || len(member.Roles) != 0 || device.ProfileID != replay.ProfileID ||
		device.PublicKey != testSigningKey(12) || device.Revoked || recipient.Kind != "device" || recipient.ProfileID != replay.ProfileID ||
		recipient.PublicKey != accepted.AgreementKey || state.Admissions["private"][replay.ProfileID].FirstPosition != 1 {
		t.Fatalf("unexpected enrollment: rev=%d member=%+v device=%+v key=%+v", enrolled.Draft.Revision, member, device, recipient)
	}
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := access.VerifyActivatedPolicyChain(ctx, tx, anchor.Digest, anchor.Principal, verifyProtectedPolicyDraft); err != nil {
		t.Fatalf("restart policy verification: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	verifyApplicantPolicyInClient(t, page, serverID, anchor, runtime.cutoverDigest)
	if _, err := runtime.openSession(ctx, sessionProof(13)); err == nil {
		t.Fatal("another device opened the invitee's session")
	}
	openBody, err := json.Marshal(sessionProof(12))
	if err != nil {
		t.Fatal(err)
	}
	openRequest := httptest.NewRequest(http.MethodPost, "/api/v3/session/open", bytes.NewReader(openBody))
	openRequest.TLS = &tls.ConnectionState{}
	openRequest.Header.Set("Content-Type", "application/json")
	openResponse := httptest.NewRecorder()
	handler.ServeHTTP(openResponse, openRequest)
	var session protectedSessionReceipt
	if openResponse.Code != http.StatusCreated || json.Unmarshal(openResponse.Body.Bytes(), &session) != nil ||
		session.ProfileID != replay.ProfileID || session.DeviceID != replay.DeviceID {
		t.Fatalf("enrolled device session: %d %s", openResponse.Code, openResponse.Body.String())
	}
	var visible access.Projection
	if w := get("/api/v3/state", session.Token); w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &visible) != nil ||
		len(visible.Channels) != 1 || visible.Channels[0].ID != "private" || visible.CanListMembers {
		t.Fatalf("enrolled participant channel state: %d %s", w.Code, w.Body.String())
	}
	for _, check := range []struct {
		path, token string
	}{{"/api/v3/state", pending.Token}, {pendingStatePath, session.Token}} {
		if w := get(check.path, check.token); w.Code != http.StatusUnauthorized {
			t.Fatalf("session crossed token scopes on %s: %d %s", check.path, w.Code, w.Body.String())
		}
	}
	if err := server.db.QueryRow("SELECT count(*) FROM devices WHERE device_id=?", replay.DeviceID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("session changed the legacy devices table: %d %v", count, err)
	}
	resolve := runtime.resolveSession(session.Token)
	revoke, err := store.PreviewPolicy(ctx, resolve, access.PolicyDraft{Action: access.RevokePolicyDevice,
		OperationID: strings.Repeat("9", 32), DeviceChange: &access.PolicyDeviceChange{DeviceID: session.DeviceID}})
	if err != nil {
		t.Fatal(err)
	}
	invitee := memberSession{Access: memberAccess{memberIdentity: memberIdentity{DeviceID: session.DeviceID}, EffectiveProfileID: session.ProfileID}}
	if _, err := store.CommitPolicy(ctx, resolve, verifyProtectedPolicyDraft, signTestPolicyDraft(t, server, invitee, 12, revoke)); err != nil {
		t.Fatalf("new device signature could not revoke its own access: %v", err)
	}
	if w := get("/api/v3/state", session.Token); w.Code != http.StatusForbidden {
		t.Fatalf("revoked device retained access via its token: %d %s", w.Code, w.Body.String())
	}
	checkSessionDenied(http.StatusForbidden, "PROTECTED_DEVICE_REVOKED")
	restart, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restart.Rollback()
	if err := access.VerifyActivatedPolicyChain(ctx, restart, anchor.Digest, anchor.Principal, verifyProtectedPolicyDraft); err != nil {
		t.Fatalf("could not verify historical signature of revoked API 3 device: %v", err)
	}
	if err := restart.Rollback(); err != nil {
		t.Fatal(err)
	}
	runtime.store.protectedBinding = strings.Repeat("e", 64)
	if w := get(pendingStatePath, pending.Token); w.Code != http.StatusUnauthorized {
		t.Fatalf("pending session survived runtime binding change: %d %s", w.Code, w.Body.String())
	}

	automatic, automaticKey := issue(strings.Repeat("a", 32), 1, owner, 1)
	newClaim := claim(automatic, automaticKey, strings.Repeat("c", 32), 14)
	headBefore, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	var serverKey []byte
	if err := server.db.QueryRowContext(ctx, "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&serverKey); err != nil {
		t.Fatal(err)
	}
	failedSigning := errors.New("synthetic signing failure")
	if _, err := store.RedeemInvite(ctx, newClaim, runtime.verifyInviteApplicant, verifyProtectedInvitationSignature, verifyProtectedPolicyDraft,
		&access.InviteEnrollment{CutoverDigest: runtime.cutoverDigest, ServerKey: b64.EncodeToString(serverKey),
			Sign: func(context.Context, access.SessionQuery, access.Principal, access.PolicyDraft) ([]byte, error) {
				return nil, failedSigning
			},
		}); !errors.Is(err, failedSigning) {
		t.Fatalf("expected signing failure: %v", err)
	}
	var failedUses, failedReceipts int
	if err := server.db.QueryRowContext(ctx, "SELECT uses,(SELECT COUNT(*) FROM protected_invite_admissions WHERE invite_id=?) FROM protected_invites WHERE id=?",
		automatic.ID, automatic.ID).Scan(&failedUses, &failedReceipts); err != nil || failedUses != 0 || failedReceipts != 0 {
		t.Fatalf("failed enrollment consumed invitation: uses=%d receipts=%d error=%v", failedUses, failedReceipts, err)
	}
	afterFailure, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil || afterFailure.Digest != headBefore.Digest {
		t.Fatalf("failed enrollment changed policy: %v %v", afterFailure.Digest, err)
	}
	redeemAutomatically := func(input access.InviteRedeem) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/api/v3/invites/redeem", bytes.NewReader(body))
		r.TLS = &tls.ConnectionState{}
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := redeemAutomatically(newClaim); w.Code != http.StatusOK {
		t.Fatalf("automatic enrollment: %d %s", w.Code, w.Body.String())
	}
	if w := redeemAutomatically(newClaim); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"existing":true`) {
		t.Fatalf("automatic retry: %d %s", w.Code, w.Body.String())
	}
	if w := redeemAutomatically(claim(automatic, automaticKey, strings.Repeat("d", 32), 15)); w.Code != http.StatusGone {
		t.Fatalf("automatic enrollment exceeded one use: %d %s", w.Code, w.Body.String())
	}
	current, currentRevision, err := store.Snapshot(ctx)
	joinedProfile := publicKeyID(newTestMemberSigner(14).root.Public().(ed25519.PublicKey))
	if err != nil || currentRevision != headBefore.Draft.Revision+1 || current.InvitationUses[automatic.ID].Count != 1 ||
		!current.Members[joinedProfile].Active {
		t.Fatalf("automatic enrollment missing from policy: revision=%d usage=%+v %v", currentRevision, current.InvitationUses[automatic.ID], err)
	}
	automaticPage, err := store.PolicyProofPage(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	verifyAutomaticInvitePolicyInClient(t, server, automaticPage, serverID, anchor, runtime.cutoverDigest, joinedProfile)
}

func verifyAutomaticInvitePolicyInClient(t *testing.T, server *membershipStore, page access.PolicyPage,
	serverID string, anchor access.PolicyProof, cutover, profile string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Log("Node unavailable, skipping automatic invite client replay")
		return
	}
	last := len(page.Proofs) - 1
	proofs := append([]access.PolicyWireProof(nil), page.Proofs...)
	var state access.State
	var proof access.PolicyProof
	if err := json.Unmarshal(proofs[last].Snapshot, &state); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(proofs[last].Record, &proof); err != nil {
		t.Fatal(err)
	}
	member := state.Members[profile]
	member.Roles = []string{"reader"}
	state.Members[profile] = member
	proofs[last].Snapshot, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	proof.Draft.ResultDigest = publicKeyID(proofs[last].Snapshot)
	proof.Draft.Signature, err = signProtectedServerPolicy(context.Background(), server.db, proof.Principal, proof.Draft)
	if err != nil {
		t.Fatal(err)
	}
	proofs[last].Record, err = json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	forged := page
	forged.Proofs = proofs
	forged.HeadDigest = publicKeyID(proof.Draft.Signature)
	raw, err := json.Marshal(map[string]access.PolicyPage{"page": page, "forged": forged})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(node, "-e", `
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { ProtectedPolicyCheckpoint } = require('../client/windows/electron/protected-policy-checkpoint.cjs');
const [serverId, ownerProfileId, ownerDeviceId, anchorDigest, cutoverDigest] = process.argv.slice(1);
const { page, forged } = JSON.parse(readFileSync(0, 'utf8'));
const trust = { serverId, ownerProfileId, ownerDeviceId, anchorDigest, cutoverDigest };
const checkpoint = new ProtectedPolicyCheckpoint({ load: async () => null, save: async () => {} });
(async () => {
  await assert.rejects(checkpoint.accept(forged, trust), /UNAUTHORIZED_POLICY_TRANSITION/);
  assert.deepEqual(await checkpoint.accept(page, trust), { revision: page.headRevision, digest: page.headDigest, complete: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
`, serverID, anchor.Principal.ProfileID, anchor.Principal.DeviceID, anchor.Digest, cutover)
	command.Stdin = bytes.NewReader(raw)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("automatic invite replay: %v\n%s", err, output)
	}
}

func verifyApplicantPolicyInClient(t *testing.T, page access.PolicyPage, serverID string, anchor access.PolicyProof, cutover string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Log("Node unavailable, skipping client replay")
		return
	}
	altered := page.Proofs[2]
	var proof access.PolicyProof
	if err := json.Unmarshal(altered.Record, &proof); err != nil {
		t.Fatal(err)
	}
	proof.Draft.ResourceChange.Admission.Issuance.MaxUses++
	frame, err := protectedPolicyFrame(serverID, anchor.Principal, proof.Draft)
	if err != nil {
		t.Fatal(err)
	}
	proof.Draft.Signature = ed25519.Sign(newTestMemberSigner(1).device, frame)
	altered.Record, err = json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	altered.ResourceChange, err = json.Marshal(proof.Draft.ResourceChange)
	if err != nil {
		t.Fatal(err)
	}
	forged := page
	forged.HeadDigest = publicKeyID(proof.Draft.Signature)
	forged.Proofs = []access.PolicyWireProof{page.Proofs[0], page.Proofs[1], altered}
	raw, err := json.Marshal(map[string]access.PolicyPage{"page": page, "forged": forged})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(node, "-e", `
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { ProtectedPolicyCheckpoint } = require('../client/windows/electron/protected-policy-checkpoint.cjs');
const [serverId, ownerProfileId, ownerDeviceId, anchorDigest, cutoverDigest] = process.argv.slice(1);
const { page, forged } = JSON.parse(readFileSync(0, 'utf8'));
const trust = { serverId, ownerProfileId, ownerDeviceId, anchorDigest, cutoverDigest };
const checkpoint = new ProtectedPolicyCheckpoint({ load: async () => null, save: async () => {} });
(async () => {
  await assert.rejects(checkpoint.accept(page, { ...trust, cutoverDigest: '0'.repeat(64) }), /INVALID_PROTECTED_INVITE_PROOF/);
  await assert.rejects(checkpoint.accept(forged, trust), /INVALID_PROTECTED_INVITE_ISSUER/);
  const expected = { revision: 3, digest: page.headDigest, complete: true };
  assert.deepEqual(await checkpoint.accept(page, trust), expected);

  let saved;
  const credentials = { load: async () => saved, save: async (_slot, value) => { saved = value; } };
  const first = new ProtectedPolicyCheckpoint(credentials);
  await first.accept({ ...page, proofs: page.proofs.slice(0, 2) }, trust);
  const reloaded = new ProtectedPolicyCheckpoint(credentials);
  const enrollment = { ...page, proofs: page.proofs.slice(2) };
  const fetchPage = async after => ({ ...page, proofs: page.proofs.slice(after) });
  await assert.rejects(reloaded.accept(enrollment, trust), /UNVERIFIED_INVITE_HISTORY/);
  assert.equal((await reloaded.load(trust)).revision, 2);
  assert.deepEqual(await reloaded.accept(enrollment, trust, fetchPage), expected);

  const head = await reloaded.load(trust);
  assert.equal((await reloaded.verifyHistory(trust, head, 2, fetchPage)).revision, 2);
  let requests = 0;
  await assert.rejects(reloaded.verifyHistory(trust, head, 2, async after => {
    const result = await fetchPage(after);
    if (++requests === 2) result.proofs[0] = { ...result.proofs[0], snapshot: Buffer.from('{}').toString('base64') };
    return result;
  }), /INVALID_POLICY_SNAPSHOT/);
})().catch(error => { console.error(error); process.exitCode = 1; });
`, serverID, anchor.Principal.ProfileID, anchor.Principal.DeviceID, anchor.Digest, cutover)
	command.Stdin = bytes.NewReader(raw)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("client policy replay: %v\n%s", err, output)
	}
}
