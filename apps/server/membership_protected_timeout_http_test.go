package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedTimeoutRuntime(t *testing.T) {
	ctx := context.Background()
	pathOnDisk := filepath.Join(t.TempDir(), membershipDatabaseFile)
	store, err := openMembershipStore(pathOnDisk)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	base := store.now()
	var elapsed atomic.Int64
	store.now = func() time.Time { return base.Add(time.Duration(elapsed.Load())) }
	text, voice := strings.Repeat("a", 32), strings.Repeat("b", 32)
	_, initial, owner, reader := protectedTestStateWith(t, store, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "member.timeout", "message.send", "voice.connect"}}
		delete(state.Channels, "private")
		state.Channels[text] = access.Channel{Kind: "text", NextPosition: 1}
		state.Channels[voice] = access.Channel{Kind: "voice", NextPosition: 1}
	})
	draft, err := store.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	proof, err := store.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, store, owner, 1, draft))
	if err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := store.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	store.protectedBinding = strings.Repeat("d", 64)
	if _, err := store.db.ExecContext(ctx, protectedSessionSchema+protectedVoiceKeySchema); err != nil {
		t.Fatal(err)
	}
	runtime := &protectedRuntime{store: store, serverID: serverID, cutoverDigest: strings.Repeat("c", 64),
		anchorDigest: proof.Digest, challenges: make(map[string]int64)}
	openSession := func(member memberSession, seed byte) protectedSessionReceipt {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest,
			store.protectedBinding, challenge.Nonce, member.Access.DeviceID)
		if err != nil {
			t.Fatal(err)
		}
		session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: member.Access.DeviceID, Nonce: challenge.Nonce,
			Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	admin, target := openSession(owner, 1), openSession(reader, 2)
	actor := access.Principal{ProfileID: target.ProfileID, DeviceID: target.DeviceID}
	grantDigest := strings.Repeat("f", 64)
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	now := store.now().UnixMilli()
	if _, err := access.ReserveVoice(ctx, tx, actor, target.SessionID, voice, now, now+30000, now+30000); err != nil {
		t.Fatal(err)
	}
	if err := access.RecordVoiceGrant(ctx, tx, voice, target.ProfileID, target.SessionID, grantDigest, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_voice_keys
		(channel_id,epoch_id,binding,revision,policy_digest,roster_digest,expires_at) VALUES(?, 'epoch', ?,1,?,?,?)`,
		voice, store.protectedBinding, proof.Digest, grantDigest, now+30000); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	call := func(method, path, token string, body any, status int, out any) {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(ctx, method, room.URL+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, err := room.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != status {
			var details json.RawMessage
			_ = json.NewDecoder(response.Body).Decode(&details)
			t.Fatalf("%s %s status %d, expected %d: %s", method, path, response.StatusCode, status, details)
		}
		if out != nil {
			if err := json.NewDecoder(response.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
	}
	path := "/api/v3/moderation/timeout/" + target.ProfileID
	input := access.TimeoutRequest{OperationID: strings.Repeat("2", 32), DurationSeconds: 60, Reason: "  Synthetic reason  "}
	call(http.MethodPut, path, target.Token, input, http.StatusForbidden, nil)
	for _, seconds := range []int64{59, 2419201} {
		invalid := input
		invalid.DurationSeconds = seconds
		call(http.MethodPut, path, admin.Token, invalid, http.StatusBadRequest, nil)
	}
	invalid := input
	invalid.Reason = "  "
	call(http.MethodPut, path, admin.Token, invalid, http.StatusBadRequest, nil)
	var receipt access.TimeoutReceipt
	call(http.MethodPut, path, admin.Token, input, http.StatusOK, &receipt)
	if receipt.Existing || receipt.Deadline != now+60000 {
		t.Fatalf("incorrect first receipt: %+v", receipt)
	}
	elapsed.Add(int64(time.Second))
	call(http.MethodPut, path, admin.Token, input, http.StatusOK, &receipt)
	if !receipt.Existing || receipt.Deadline != now+60000 {
		t.Fatalf("retry advanced the timeout: %+v", receipt)
	}
	conflicting := input
	conflicting.Reason = "Different reason"
	call(http.MethodPut, path, admin.Token, conflicting, http.StatusConflict, nil)
	var self access.Projection
	call(http.MethodGet, "/api/v3/state", target.Token, nil, http.StatusOK, &self)
	if len(self.Channels) != 2 || self.Timeout == nil || self.Timeout.Reason != "Synthetic reason" ||
		!self.Timeout.CanLift || !self.CanManageTimeouts {
		t.Fatalf("incorrect target state: %+v", self)
	}
	message := access.MessageAttempt{ChannelID: text, OperationID: strings.Repeat("5", 32), KeyID: grantDigest,
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64)}
	var failure struct{ Error struct{ Code string } }
	call(http.MethodPost, "/api/v3/history/live/"+text, target.Token, message, http.StatusForbidden, &failure)
	if failure.Error.Code != "PROTECTED_TIMED_OUT" {
		t.Fatalf("unexpected send denial: %+v", failure)
	}
	call(http.MethodPost, "/api/v3/voice/"+voice+"/prepare", target.Token, nil, http.StatusForbidden, nil)
	var keys, pending int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM protected_voice_keys").Scan(&keys); err != nil || keys != 0 {
		t.Fatalf("voice package head retained: %d, %v", keys, err)
	}
	if err := store.db.QueryRow("SELECT disconnect_pending FROM protected_voice_slots WHERE profile_id=?", target.ProfileID).
		Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("active voice disconnection was not scheduled: %d, %v", pending, err)
	}
	var attempts atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Identity string }
		if r.URL.Path != "/twirp/livekit.RoomService/RemoveParticipant" ||
			json.NewDecoder(r.Body).Decode(&body) != nil || body.Identity != target.SessionID {
			http.Error(w, "unexpected media operation", http.StatusBadRequest)
			return
		}
		if attempts.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer media.Close()
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("c", 64), PresenceURL: media.URL}
	if err := store.reconcilePendingProtectedVoice(ctx, cfg); err == nil {
		t.Fatal("transient media failure did not preserve reconciliation")
	}
	if err := store.reconcilePendingProtectedVoice(ctx, cfg); err != nil || attempts.Load() != 2 {
		t.Fatalf("voice removal retry failed: %v", err)
	}
	lift := access.TimeoutRequest{OperationID: strings.Repeat("3", 32), Reason: "Review completed"}
	call(http.MethodPut, path, target.Token, lift, http.StatusOK, &receipt)
	if receipt.Deadline != 0 {
		t.Fatalf("self-lift did not clear the deadline: %+v", receipt)
	}
	call(http.MethodGet, "/api/v3/audit", target.Token, nil, http.StatusForbidden, nil)
	var audit access.AuditPage
	call(http.MethodGet, "/api/v3/audit", admin.Token, nil, http.StatusOK, &audit)
	if len(audit.Entries) != 2 || audit.Entries[0].Actor != target.ProfileID || audit.Entries[0].Reason != lift.Reason ||
		audit.Entries[1].Actor != admin.ProfileID || audit.Entries[1].Reason != "Synthetic reason" || audit.Retention != 365 {
		t.Fatalf("timeout audit projection: %+v", audit)
	}
	retention := access.AuditRetentionRequest{Days: 30, Expected: 365}
	call(http.MethodPut, "/api/v3/audit/retention", target.Token, retention, http.StatusForbidden, nil)
	call(http.MethodPut, "/api/v3/audit/retention", admin.Token, retention, http.StatusConflict, nil)
	retention.ConfirmShorter = true
	call(http.MethodPut, "/api/v3/audit/retention", admin.Token, retention, http.StatusOK, nil)
	tx, err = store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	expiredGrant := access.ValidateVoiceSignal(ctx, tx, actor, voice, target.SessionID, grantDigest, false, true, store.now().UnixMilli())
	tx.Rollback()
	if !errors.Is(expiredGrant, access.ErrVoiceSlotLost) {
		t.Fatalf("old voice grant after self-lift: %v", expiredGrant)
	}
	input.OperationID = strings.Repeat("4", 32)
	input.DurationSeconds = 2419200
	call(http.MethodPut, path, admin.Token, input, http.StatusOK, &receipt)
	var recordedActor string
	if err := store.db.QueryRow("SELECT actor_profile_id FROM protected_timeout_actions WHERE operation_id=?", lift.OperationID).
		Scan(&recordedActor); err != nil || recordedActor != target.ProfileID {
		t.Fatalf("timeout audit lost self-lift actor: %q, %v", recordedActor, err)
	}
	if head, err := access.ReadPolicyHead(ctx, store.db, nil); err != nil || head.Digest != proof.Digest {
		t.Fatalf("timeout changed signed recipient state: %v", err)
	}
	initial.Roles["listener"] = access.Role{Grants: []string{access.ChannelView, "voice.connect", "member.list"}}
	roleDraft, err := store.previewProtectedPolicy(ctx, admin.Token, access.PolicyDraft{
		Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("6", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: append(initial.Order, "listener"),
			Assignments: map[string][]string{target.ProfileID: {"listener"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	newPolicy, err := store.commitProtectedPolicy(ctx, admin.Token, signTestPolicyDraft(t, store, owner, 1, roleDraft))
	if err != nil {
		t.Fatal(err)
	}
	room.Close()
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := openMigrationImportDatabase(pathOnDisk)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store = &membershipStore{db: db, now: store.now, maxBytes: store.maxBytes, protectedBinding: strings.Repeat("e", 64)}
	runtime = &protectedRuntime{store: store, serverID: serverID, cutoverDigest: runtime.cutoverDigest,
		anchorDigest: proof.Digest, challenges: make(map[string]int64)}
	room = httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	call(http.MethodGet, path, target.Token, nil, http.StatusUnauthorized, nil)
	freshSession := openSession(reader, 2)
	var status access.TimeoutStatus
	call(http.MethodGet, path, freshSession.Token, nil, http.StatusOK, &status)
	if status.Deadline != receipt.Deadline || status.Reason != "Synthetic reason" || status.CanLift ||
		receipt.Deadline != store.now().Add(28*24*time.Hour).UnixMilli() {
		t.Fatalf("maximum duration or current moderator grant after restart: %+v", status)
	}
	// Reauthenticate as the target after 28 days, with the moderator still offline.
	elapsed.Add(int64(28*24*time.Hour - time.Millisecond))
	freshSession = openSession(reader, 2)
	call(http.MethodGet, path, freshSession.Token, nil, http.StatusOK, &status)
	if status.Deadline != receipt.Deadline {
		t.Fatalf("timeout ended early at %d: %+v", store.now().UnixMilli(), status)
	}
	call(http.MethodPost, "/api/v3/voice/"+voice+"/prepare", freshSession.Token, nil, http.StatusForbidden, nil)
	elapsed.Add(int64(time.Millisecond))
	status = access.TimeoutStatus{}
	call(http.MethodGet, path, freshSession.Token, nil, http.StatusOK, &status)
	if store.now().UnixMilli() != receipt.Deadline || status.Deadline != 0 || status.Reason != "" {
		t.Fatalf("timeout active at the exact deadline: %+v", status)
	}
	call(http.MethodPost, "/api/v3/voice/"+voice+"/prepare", freshSession.Token, nil, http.StatusOK, nil)
	call(http.MethodPost, "/api/v3/history/live/"+text, freshSession.Token, message, http.StatusForbidden, &failure)
	if failure.Error.Code != "PROTECTED_ACCESS_DENIED" {
		t.Fatalf("expired timeout restored old message.send grant: %+v", failure)
	}
	self = access.Projection{}
	call(http.MethodGet, "/api/v3/state", freshSession.Token, nil, http.StatusOK, &self)
	if self.PolicyRevision != newPolicy.Draft.Revision || !self.CanListMembers || self.CanManageTimeouts || self.Timeout != nil {
		t.Fatalf("expiry replaced the current role assignment: %+v", self)
	}
	if head, err := access.ReadPolicyHead(ctx, db, nil); err != nil || head.Digest != newPolicy.Digest {
		t.Fatalf("expiry changed the currently signed policy: %v", err)
	}
}
