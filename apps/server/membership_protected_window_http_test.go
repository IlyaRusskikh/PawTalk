package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedTextWindowHTTP(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	var now atomic.Int64
	now.Store(10_000_000)
	server.now = func() time.Time { return time.UnixMilli(now.Load()) }
	const (
		channel = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		lagging = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		hidden  = "cccccccccccccccccccccccccccccccc"
		voice   = "dddddddddddddddddddddddddddddddd"
		missing = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	)
	_, initial, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Order = []string{"viewer", "reader"}
		state.Roles["viewer"] = access.Role{Grants: []string{access.ChannelView}}
		state.Channels = map[string]access.Channel{
			channel: {Kind: "text", NextPosition: 1},
			lagging: {Kind: "text", NextPosition: 1},
			hidden: {Kind: "text", NextPosition: 1, ACL: access.ACL{
				Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}}}},
			voice: {Kind: "voice", NextPosition: 1},
		}
	})
	commit := func(input access.PolicyDraft) access.PolicyProof {
		t.Helper()
		draft, err := server.previewProtectedPolicy(ctx, owner.Token, input)
		if err != nil {
			t.Fatal(err)
		}
		proof, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, draft))
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := commit(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	server.protectedBinding = strings.Repeat("9", 64)
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: strings.Repeat("c", 64),
		anchorDigest: anchor.Digest, challenges: make(map[string]int64)}
	open := func(member memberSession, seed byte) string {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		device := member.Access.DeviceID
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest, server.protectedBinding, challenge.Nonce, device)
		if err != nil {
			t.Fatal(err)
		}
		session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: device, Nonce: challenge.Nonce,
			Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return session.Token
	}
	ownerToken, readerToken := open(owner, 1), open(reader, 2)
	owner.Token = ownerToken
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	get := func(channel, token string, status int) []byte {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, room.URL+"/api/v3/protection/"+channel+"/window", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := room.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status {
			t.Fatalf("channel %s: got status %d, want %d: %s", channel, response.StatusCode, status, body)
		}
		return body
	}
	check := func(channel, token string, head access.PolicyProof, want access.ProtectionWindow) {
		t.Helper()
		want.PolicyHead, want.PolicyRevision, want.ServerNow = head.Digest, head.Draft.Revision, now.Load()
		want.DeferredSend = true
		body := get(channel, token, http.StatusOK)
		var value access.ProtectionWindow
		if err := json.Unmarshal(body, &value); err != nil || value != want {
			t.Fatalf("channel %s window: got %+v, want %+v, err %v", channel, value, want, err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(body, &fields); err != nil {
			t.Fatal(err)
		}
		_, hasKeyID := fields["currentKeyId"]
		delete(fields, "currentKeyId")
		if hasKeyID != (want.CurrentGeneration != 0) || len(fields) != 9 {
			t.Fatalf("unexpected window fields: %s", body)
		}
	}
	rotate := func(channel, key string) {
		t.Helper()
		record, packages := prepareTestEpoch(t, server, owner, 1, channel, key)
		if err := server.commitProtectedEpoch(ctx, owner.Token, record, packages); err != nil {
			t.Fatal(err)
		}
	}
	check(channel, readerToken, anchor, access.ProtectionWindow{})
	denied := get(hidden, readerToken, http.StatusForbidden)
	if string(denied) != string(get(missing, readerToken, http.StatusForbidden)) ||
		string(denied) != string(get(voice, ownerToken, http.StatusForbidden)) {
		t.Fatal("a hidden, missing or non-text channel returned distinct metadata")
	}
	get(channel, "", http.StatusUnauthorized)

	first, second := strings.Repeat("a", 64), strings.Repeat("b", 64)
	laggingKey := strings.Repeat("c", 64)
	rotate(channel, first)
	rotate(lagging, laggingKey)
	check(channel, readerToken, anchor, access.ProtectionWindow{CurrentGeneration: 1, CurrentKeyID: first})

	assign := func(operation string, roles []string) access.PolicyProof {
		t.Helper()
		return commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat(operation, 32),
			RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order,
				Assignments: map[string][]string{reader.Access.EffectiveProfileID: roles}}})
	}
	revoked := assign("2", nil)
	cutoff := now.Load() + 60_000
	get(channel, readerToken, http.StatusForbidden)
	check(channel, ownerToken, revoked, access.ProtectionWindow{CurrentGeneration: 1, CurrentKeyID: first, CurrentCutoff: cutoff})

	now.Add(59_000)
	rotate(channel, second)
	transition := access.ProtectionWindow{CurrentGeneration: 2, CurrentKeyID: second, PreviousGeneration: 1, PreviousCutoff: cutoff}
	check(channel, ownerToken, revoked, transition)
	now.Add(1_000)
	check(channel, ownerToken, revoked, transition)
	check(lagging, ownerToken, revoked, access.ProtectionWindow{CurrentGeneration: 1, CurrentKeyID: laggingKey, CurrentCutoff: cutoff})

	admitted := assign("3", []string{"viewer"})
	transition.NeedsFresh = true
	check(channel, readerToken, admitted, transition)

	if _, err := server.db.ExecContext(ctx, "UPDATE protected_epochs SET key_id=? WHERE channel_id=? AND generation=2",
		strings.Repeat("f", 64), channel); err != nil {
		t.Fatal(err)
	}
	get(channel, ownerToken, http.StatusServiceUnavailable)
}
