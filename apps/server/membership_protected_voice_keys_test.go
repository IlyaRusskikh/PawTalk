package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedVoiceKeyOfferInteroperability(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	store := testMembershipStore(t)
	now := store.now()
	store.now = func() time.Time { return now }
	channel, binding := strings.Repeat("a", 32), strings.Repeat("b", 64)
	_, state, owner, reader := protectedTestStateWith(t, store, func(state *access.State) {
		state.Channels[channel] = access.Channel{Kind: "voice", NextPosition: 1}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect"}}
	})
	draft, err := store.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, store, owner, 1, draft)); err != nil {
		t.Fatal(err)
	}
	state.PolicyAnchored = true
	if _, err := store.db.ExecContext(ctx, protectedSessionSchema+protectedVoiceKeySchema); err != nil {
		t.Fatal(err)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	authorSession, readerSession := strings.Repeat("1", 32), strings.Repeat("2", 32)
	var tokens []string
	for index, fixture := range []struct {
		session string
		member  memberAccess
	}{{authorSession, owner.Access}, {readerSession, reader.Access}} {
		raw := bytes.Repeat([]byte{byte(index)}, 32)
		hash := sha256.Sum256(raw)
		tokens = append(tokens, b64.EncodeToString(raw))
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_runtime_sessions (session_id,device_id,token_hash,binding,expires_at)
			VALUES(?,?,?,?,?)`, fixture.session, fixture.member.DeviceID, hash[:], binding, now.Add(time.Hour).UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	runtime := &protectedRuntime{store: &membershipStore{db: store.db, now: store.now, protectedBinding: binding}, serverID: serverID}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rtc" {
			t.Errorf("unexpected signaling path %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("c", 64)}
	server := httptest.NewTLSServer(runtime.handlerWithVoice(cfg, target))
	defer server.Close()
	call := func(method, path, token string, body []byte, want int, result any) {
		t.Helper()
		if !strings.HasPrefix(path, "/") {
			path = "/api/v3/voice/" + channel + "/" + path
		}
		request, err := http.NewRequestWithContext(ctx, method, server.URL+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			var failure json.RawMessage
			_ = json.NewDecoder(response.Body).Decode(&failure)
			t.Fatalf("%s %s got %d, want %d: %s", method, path, response.StatusCode, want, failure)
		}
		if result != nil {
			if err := json.NewDecoder(response.Body).Decode(result); err != nil {
				t.Fatal(err)
			}
		}
	}
	call(http.MethodPost, "key/claim", tokens[1], nil, http.StatusForbidden, nil)
	for _, token := range tokens {
		call(http.MethodPost, "prepare", token, nil, http.StatusOK, nil)
	}
	var claim, secondClaim protectedVoiceKeyClaim
	call(http.MethodPost, "key/claim", tokens[0], nil, http.StatusOK, &claim)
	call(http.MethodPost, "key/claim", tokens[1], nil, http.StatusOK, &secondClaim)
	if claim.Published || secondClaim.Published || claim.Basis != secondClaim.Basis || len(claim.Roster) != 2 {
		t.Fatalf("speaker and listener should share one unpublished claim: %+v %+v", claim, secondClaim)
	}
	call(http.MethodGet, "key", tokens[0], nil, http.StatusConflict, nil)
	basis, roster := claim.Basis, claim.Roster
	if basis.PolicyDigest != draft.ResultDigest {
		t.Fatal("claim did not bind the current signed policy")
	}
	joinPath := "/api/v3/voice/join"
	joinBody, err := json.Marshal(map[string]string{"channelId": channel, "keyEpoch": basis.EpochID})
	if err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, joinPath, tokens[1], joinBody, http.StatusConflict, nil)
	payload, err := json.Marshal(map[string]any{"basis": basis, "roster": roster, "authorSession": authorSession,
		"snapshot": state, "now": now.UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../client/windows/scripts/protected-voice-key-integration.cjs")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, node, script)
	hideWindow(cmd)
	cmd.Stdin = bytes.NewReader(payload)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("client voice key exchange: %v\n%s", err, output)
	}
	var offer protectedVoiceKeyOffer
	if err := json.Unmarshal(output, &offer); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPut, "key", tokens[1], output, http.StatusForbidden, nil)
	if _, err := store.db.ExecContext(ctx, `CREATE TRIGGER reject_fixture_voice_package BEFORE INSERT ON protected_voice_key_packages
		WHEN NEW.session_id='22222222222222222222222222222222' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPut, "key", tokens[0], output, http.StatusInternalServerError, nil)
	call(http.MethodGet, "key", tokens[0], nil, http.StatusConflict, nil)
	if _, err := store.db.ExecContext(ctx, "DROP TRIGGER reject_fixture_voice_package"); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPut, "key", tokens[0], output, http.StatusOK, nil)
	call(http.MethodPut, "key", tokens[0], output, http.StatusOK, nil)
	offer.Packages[authorSession][0] ^= 1
	competing, err := json.Marshal(offer)
	if err != nil {
		t.Fatal(err)
	}
	call(http.MethodPut, "key", tokens[0], competing, http.StatusConflict, nil)
	offer.Packages[authorSession][0] ^= 1
	for index, token := range tokens {
		var delivered protectedVoiceKeyDelivery
		call(http.MethodGet, "key", token, nil, http.StatusOK, &delivered)
		if delivered.Basis != basis || !bytes.Equal(delivered.Ciphertext, offer.Packages[roster[index].SessionID]) ||
			delivered.AuthorSession != authorSession {
			t.Fatal("delivery returned an unexpected recipient or epoch")
		}
	}
	now = now.Add(30 * time.Second)
	var listenerGrant memberVoice
	call(http.MethodPost, joinPath, tokens[1], joinBody, http.StatusOK, &listenerGrant)
	claims, err := verifyMediaGrant(cfg, listenerGrant.Token, now)
	if err != nil || *claims.Video.CanPublish || !*claims.Video.CanSubscribe || listenerGrant.KeyEpoch != basis.EpochID ||
		listenerGrant.ExpiresAt > basis.ExpiresAt || listenerGrant.ExpiresAt >= now.Add(protectedVoiceLease).UnixMilli() {
		t.Fatalf("grant did not inherit listener permissions and key deadline: %+v %v", listenerGrant, err)
	}
	call(http.MethodGet, "/rtc/rtc", listenerGrant.Token, nil, http.StatusNoContent, nil)
	call(http.MethodPost, "/api/v3/voice/leave", tokens[0], []byte("{}"), http.StatusAccepted, nil)
	call(http.MethodGet, "/rtc/rtc", listenerGrant.Token, nil, http.StatusForbidden, nil)
	call(http.MethodPost, "prepare", tokens[0], nil, http.StatusOK, nil)
	call(http.MethodGet, "/rtc/rtc", listenerGrant.Token, nil, http.StatusForbidden, nil)
	tx, err = store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := verifyProtectedVoiceKeyOffer(ctx, tx, now, basis, roster, roster[0], offer); err != nil {
		t.Fatal(err)
	}
	if err := verifyProtectedVoiceKeyOffer(ctx, tx, now, basis, roster, roster[1], offer); err == nil {
		t.Fatal("a different listener could claim the offer")
	}
	if err := verifyProtectedVoiceKeyOffer(ctx, tx, time.UnixMilli(basis.ExpiresAt), basis, roster, roster[0], offer); !errors.Is(err, access.ErrVoiceGrantChanged) {
		t.Fatalf("expired basis accepted: %v", err)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_runtime_sessions SET expires_at=0 WHERE session_id=?", readerSession); err != nil {
		t.Fatal(err)
	}
	current, err := access.ReadVoiceKeyRoster(ctx, tx, channel, binding, now.UnixMilli())
	if err != nil || len(current) != 1 || current[0].SessionID != authorSession {
		t.Fatalf("expired device still eligible for packages: %d, %v", len(current), err)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_runtime_sessions SET expires_at=? WHERE session_id=?", now.Add(time.Hour).UnixMilli(), readerSession); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	deafen, err := store.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.ChangeVoiceDeafen, OperationID: strings.Repeat("2", 32),
		ResourceChange: &access.PolicyResourceChange{ID: channel, TargetProfileID: reader.Access.EffectiveProfileID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, store, owner, 1, deafen)); err != nil {
		t.Fatal(err)
	}
	call(http.MethodGet, "key", tokens[1], nil, http.StatusForbidden, nil)
	call(http.MethodGet, "key", tokens[0], nil, http.StatusConflict, nil)
	call(http.MethodPut, "key", tokens[0], output, http.StatusConflict, nil)
	var rotated protectedVoiceKeyClaim
	call(http.MethodPost, "key/claim", tokens[0], nil, http.StatusOK, &rotated)
	if rotated.Basis.EpochID == basis.EpochID || rotated.Published || len(rotated.Roster) != 1 {
		t.Fatalf("deafen did not invalidate the published epoch: %+v", rotated)
	}
	tx, err = store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	current, err = access.ReadVoiceKeyRoster(ctx, tx, channel, binding, now.UnixMilli())
	if err != nil || len(current) != 1 || current[0].SessionID != authorSession {
		t.Fatalf("deafened device still eligible for packages: %d, %v", len(current), err)
	}
	if err := verifyProtectedVoiceKeyOffer(ctx, tx, now, basis, current, current[0], offer); !errors.Is(err, access.ErrEpochRecipients) {
		t.Fatalf("offer with stale recipient accepted: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	now = now.Add(protectedVoiceKeyTTL)
	call(http.MethodPost, "prepare", tokens[0], nil, http.StatusOK, nil)
	call(http.MethodGet, "key", tokens[0], nil, http.StatusConflict, nil)
}
