package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func openScopedACLFixture(t *testing.T, ctx context.Context, server *membershipStore, store *access.Store, owner memberSession, version int) (
	access.PolicyProof, *protectedRuntime, func(memberSession, byte) string, func(string, string, string, []byte, int) []byte,
) {
	t.Helper()
	draft, err := store.PreviewPolicy(ctx, server.protectedSession(owner.Token), access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
		TextProjectionVersion: version, TextProjectionSeed: strings.Repeat("aa", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, draft))
	if err != nil {
		t.Fatal(err)
	}
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
	room := httptest.NewTLSServer(runtime.handler())
	t.Cleanup(room.Close)
	call := func(method, path, token string, input []byte, status int) []byte {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, method, room.URL+path, bytes.NewReader(input))
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
		body, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status {
			t.Fatalf("%s returned %d, want %d: %s", path, response.StatusCode, status, body)
		}
		return body
	}
	return anchor, runtime, open, call
}

func TestProtectedChannelACLProofScope(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	const (
		channel  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		category = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		viewOnly = "cccccccccccccccccccccccccccccccc"
		hidden   = "dddddddddddddddddddddddddddddddd"
		missing  = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	)
	var personal string
	store, initial, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		guest := activateTestMember(t, server, newTestMemberSigner(3), "member")
		personal = guest.ProfileID
		state.Order = []string{"guest", "reader"}
		state.Roles["guest"] = access.Role{Grants: []string{access.ChannelView}}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "channel.access.edit"}}
		state.Members[personal] = access.Subject{ID: personal, Active: true, Roles: []string{"guest"}}
		state.PolicyDevices[guest.DeviceID] = access.PolicyDevice{ProfileID: personal, PublicKey: testSigningKey(3)}
		state.KeyRecipients[guest.DeviceID] = access.KeyRecipient{ProfileID: personal, Kind: "device", PublicKey: testRecipientKey(t, 33)}
		state.Categories = map[string]access.ACL{category: {
			Roles: map[string]access.Overwrite{"reader": {
				Allow: []string{"voice.speak"}, Deny: []string{"message.send"},
			}},
			Profiles: map[string]access.Overwrite{personal: {Allow: []string{"message.attach"}}},
		}}
		state.Channels = map[string]access.Channel{
			channel: {Kind: "text", CategoryID: category, Synchronized: true, NextPosition: 1},
			viewOnly: {Kind: "text", NextPosition: 1, ACL: access.ACL{
				Roles: map[string]access.Overwrite{"reader": {Deny: []string{"channel.access.edit"}}}}},
			hidden: {Kind: "text", NextPosition: 1, ACL: access.ACL{
				Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}}}},
		}
	})
	anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.ChannelACLProjectionVersion)
	ownerToken, readerToken := open(owner, 1), open(reader, 2)
	get := func(path, token string, status int) []byte {
		t.Helper()
		return call(http.MethodGet, path, token, nil, status)
	}
	prefix := "/api/v3/policy/channel-acl/"
	body := get(prefix+channel, readerToken, http.StatusOK)
	var acl access.ChannelACLDisclosure
	if err := json.Unmarshal(body, &acl); err != nil || acl.ChannelID != channel || acl.CategoryID != category ||
		!acl.Synchronized || acl.Actor.DeviceID != reader.Access.DeviceID || acl.Editors.Count != 2 ||
		acl.PolicyDigest != anchor.Draft.ResultDigest || acl.Revision != anchor.Draft.Revision ||
		len(acl.Rules) != 1 || !strings.Contains(string(body), `"Deny":["message.send"]`) {
		t.Fatalf("invalid scoped proof: %s, %v", body, err)
	}
	for _, unrelated := range []string{personal, "voice.speak", "message.attach", hidden, owner.Access.DeviceID} {
		if strings.Contains(string(body), unrelated) {
			t.Fatalf("scoped proof disclosed an unrelated identifier or permission: %s", unrelated)
		}
	}
	denied := get(prefix+hidden, readerToken, http.StatusForbidden)
	for _, id := range []string{viewOnly, missing} {
		if reply := get(prefix+id, readerToken, http.StatusForbidden); string(reply) != string(denied) {
			t.Fatalf("denial reveals whether %s exists or is visible: %s versus %s", id, reply, denied)
		}
	}
	get(prefix+channel, "", http.StatusUnauthorized)
	get("/api/v3/policy/channel-order/"+channel, readerToken, http.StatusForbidden)
	var order access.ChannelOrderAuthorityProof
	if err := json.Unmarshal(get("/api/v3/policy/channel-order/"+channel, ownerToken, http.StatusOK), &order); err != nil {
		t.Fatal(err)
	}
	var settings access.ChannelSettingsDisclosure
	if err := json.Unmarshal(get("/api/v3/policy/channel-settings/"+channel, readerToken, http.StatusOK), &settings); err != nil ||
		!validHexID(order.ACLRoot, 64) || settings.ACLRoot != order.ACLRoot || settings.EditorsRoot != acl.OrderEditorsRoot {
		t.Fatalf("v10 companion proofs lost the ACL commitment: %+v, %+v, %v", order, settings, err)
	}
	var state access.Projection
	if err := json.Unmarshal(get("/api/v3/state", readerToken, http.StatusOK), &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Channels) != 2 {
		t.Fatalf("hidden channel appeared in visible state: %+v", state.Channels)
	}
	for _, item := range state.Channels {
		if item.CanInspectACL != (item.ID == channel) || item.CanOrder || item.CanEditSettings {
			t.Fatalf("unexpected ACL or order capability: %+v", item)
		}
	}

	activeOwner := owner
	activeOwner.Token = ownerToken
	epoch, packages := prepareTestEpoch(t, server, activeOwner, 1, channel, strings.Repeat("8", 64))
	if err := server.commitProtectedEpoch(ctx, ownerToken, epoch, packages); err != nil {
		t.Fatal(err)
	}
	originalRules, err := json.Marshal(acl.Rules)
	if err != nil {
		t.Fatal(err)
	}
	previousRulesDigest := publicKeyID(originalRules)
	request := func(operation string, rules []byte, signatureSeed byte) []byte {
		t.Helper()
		operation = strings.Repeat(operation, 32)
		frame, err := signatureFrame("pawtalk-protected-channel-acl-roles-edit-v1", runtime.serverID, runtime.cutoverDigest,
			reader.Access.EffectiveProfileID, reader.Access.DeviceID, operation, strconv.FormatInt(anchor.Draft.Revision, 10),
			anchor.Digest, channel, "text", category, previousRulesDigest, publicKeyID(rules))
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(map[string]any{"operationId": operation, "policyHead": anchor.Digest,
			"previousRulesDigest": previousRulesDigest, "rules": json.RawMessage(rules),
			"editorProof": b64.EncodeToString(ed25519.Sign(newTestMemberSigner(signatureSeed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	post := func(input []byte, want int) []byte {
		t.Helper()
		return call(http.MethodPost, prefix+channel, readerToken, input, want)
	}
	post(request("2", originalRules, 2), http.StatusBadRequest)
	post(request("3", []byte(`{"reader":{"Deny":["message.send"],"Allow":[]}}`), 2), http.StatusBadRequest)
	post(request("4", []byte(`{"reader":{"Allow":[],"Deny":["message.send","message.send"]}}`), 2), http.StatusBadRequest)
	newRules, err := json.Marshal(map[string]access.Overwrite{"reader": acl.Rules["reader"], "guest": {Deny: []string{access.ChannelView}}})
	if err != nil {
		t.Fatal(err)
	}
	if output := post(request("5", newRules, 1), http.StatusForbidden); !bytes.Contains(output, []byte("INVALID_PROTECTED_CHANNEL_ACL_EDIT")) {
		t.Fatalf("wrong editor signature failed for an unexpected reason: %s", output)
	}
	valid := request("6", newRules, 2)
	first := post(valid, http.StatusOK)
	if second := post(valid, http.StatusOK); !bytes.Equal(first, second) {
		t.Fatalf("exact retry changed the receipt: %s versus %s", first, second)
	}
	post(request("6", []byte("{}"), 2), http.StatusConflict)
	post(request("7", newRules, 2), http.StatusConflict)
	current, revision, err := store.Snapshot(ctx)
	updated := current.Channels[channel]
	savedPersonal := updated.ACL.Profiles[personal].Allow
	if err != nil || revision != 2 || updated.Synchronized || current.CanDeliver(personal, channel, 0) ||
		!current.CanDeliver(personal, viewOnly, 0) || current.EpochWindows[channel].CurrentCutoff == 0 ||
		len(savedPersonal) != 1 || savedPersonal[0] != "message.attach" ||
		len(current.Categories[category].Roles["reader"].Allow) != 1 || current.Categories[category].Roles["reader"].Allow[0] != "voice.speak" {
		t.Fatalf("scoped edit did not preserve personal rules and apply the role change: %+v, %v", updated, err)
	}
	var auditEvents, liveRotations int
	if err := server.db.QueryRow(`SELECT (SELECT count(*) FROM protected_audit_events WHERE channel_id=? AND action=?),
		(SELECT count(*) FROM protected_rotation_tasks WHERE channel_id=? AND purpose='live' AND revision=2)`,
		channel, access.UpdateChannelACL, channel).Scan(&auditEvents, &liveRotations); err != nil ||
		auditEvents != 1 || liveRotations != 1 {
		t.Fatalf("audit/rotation not atomic with accepted policy: %d, %d, %v", auditEvents, liveRotations, err)
	}
	head, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil || head.Draft.ResourceChange == nil || head.Draft.ResourceChange.ACL == nil ||
		head.Draft.ResourceChange.ACL.Profiles != nil || head.Draft.ResourceChange.ACLRoleEdit == nil {
		t.Fatalf("signed intent stored private or missing editing data: %+v, %v", head.Draft.ResourceChange, err)
	}
	initial.Roles["reader"] = access.Role{Grants: []string{access.ChannelView}}
	revoke, err := store.PreviewPolicy(ctx, server.protectedSession(ownerToken), access.PolicyDraft{
		Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("8", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.commitProtectedPolicy(ctx, ownerToken, signTestPolicyDraft(t, server, activeOwner, 1, revoke)); err != nil {
		t.Fatal(err)
	}
	post(valid, http.StatusForbidden)
}
