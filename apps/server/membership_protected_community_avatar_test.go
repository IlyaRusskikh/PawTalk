package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedCommunityAvatarTLS(t *testing.T) {
	const endpoint = "/api/v3/community/avatar"
	ctx := t.Context()
	server := testMembershipStore(t)
	var viewer memberSession
	store, initial, owner, editor := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{"server.edit"}}
		identity := newTestMemberSigner(3)
		activateTestMember(t, server, identity, "member")
		viewer = loginTestMember(t, server, identity)
		profile, device := viewer.Access.EffectiveProfileID, viewer.Access.DeviceID
		state.Members[profile] = access.Subject{ID: profile, Active: true}
		state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 43)}
	})
	anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.ProfileRoleAuthorityProjectionVersion)
	ownerToken, editorToken, viewerToken := open(owner, 1), open(editor, 2), open(viewer, 3)
	encode := func(value any) []byte {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	read := func(token string) access.CommunityAvatarView {
		t.Helper()
		var avatar access.CommunityAvatarView
		if err := json.Unmarshal(call(http.MethodGet, endpoint, token, nil, http.StatusOK), &avatar); err != nil {
			t.Fatal(err)
		}
		return avatar
	}
	update := func(session memberSession, seed byte, revision int64, operation string, policy access.PolicyProof) access.CommunityAvatarUpdate {
		t.Helper()
		binding := access.CommunityAvatarContext{ServerID: runtime.serverID, Revision: revision, Operation: strings.Repeat(operation, 32),
			PolicyHead: policy.Digest, ProfileID: session.Access.EffectiveProfileID, DeviceID: session.Access.DeviceID}
		packet := &access.CommunityAvatarPacket{Nonce: bytes.Repeat([]byte{1}, 12), Ciphertext: bytes.Repeat([]byte{2}, 17),
			KeyCommitment: strings.Repeat("a", 64)}
		frame, err := access.SignatureFrame("pawtalk-community-avatar-signature-v1", binding.ServerID, strconv.FormatInt(revision, 10), binding.Operation,
			binding.PolicyHead, binding.ProfileID, binding.DeviceID, packet.KeyCommitment,
			base64.RawURLEncoding.EncodeToString(packet.Nonce), publicKeyID(packet.Ciphertext))
		if err != nil {
			t.Fatal(err)
		}
		packet.Signature = ed25519.Sign(newTestMemberSigner(seed).device, frame)
		ids := []string{owner.Access.DeviceID, editor.Access.DeviceID, viewer.Access.DeviceID}
		slices.Sort(ids)
		packages := make([]access.CommunityAvatarPackage, 0, len(ids))
		for index, id := range ids {
			packages = append(packages, access.CommunityAvatarPackage{ID: id, Ciphertext: bytes.Repeat([]byte{byte(index + 3)}, 80)})
		}
		return access.CommunityAvatarUpdate{Context: binding, Packet: packet, Packages: packages}
	}
	if before := read(viewerToken); before != (access.CommunityAvatarView{Revision: 1}) {
		t.Fatalf("unexpected initial avatar: %+v", before)
	}
	call(http.MethodPut, endpoint, viewerToken, encode(update(viewer, 3, 2, "b", anchor)), http.StatusForbidden)
	first := update(editor, 2, 2, "c", anchor)
	missing := first
	missing.Packages = missing.Packages[:2]
	call(http.MethodPut, endpoint, editorToken, encode(missing), http.StatusConflict)
	call(http.MethodPut, endpoint, editorToken, encode(first), http.StatusOK)
	call(http.MethodPut, endpoint, editorToken, encode(first), http.StatusOK)
	call(http.MethodPut, endpoint, ownerToken, encode(update(owner, 1, 2, "d", anchor)), http.StatusConflict)
	call(http.MethodGet, endpoint+"/audience", viewerToken, nil, http.StatusForbidden)
	var audience access.CommunityAvatarAudience
	if err := json.Unmarshal(call(http.MethodGet, endpoint+"/audience", editorToken, nil, http.StatusOK), &audience); err != nil ||
		audience.Head != anchor.Digest || len(audience.Recipients) != len(first.Packages) {
		t.Fatalf("unexpected audience: %+v (%v)", audience, err)
	}
	for token, session := range map[string]memberSession{ownerToken: owner, editorToken: editor, viewerToken: viewer} {
		avatar := read(token)
		if avatar.Revision != 2 || avatar.Pending || avatar.Content == nil || avatar.Package == nil || avatar.Publisher == nil ||
			avatar.Content.Context != first.Context || avatar.Package.ID != session.Access.DeviceID ||
			!bytes.Equal(avatar.Content.Packet.Ciphertext, first.Packet.Ciphertext) ||
			!slices.ContainsFunc(first.Packages, func(packet access.CommunityAvatarPackage) bool {
				return packet.ID == avatar.Package.ID && bytes.Equal(packet.Ciphertext, avatar.Package.Ciphertext)
			}) {
			t.Fatalf("avatar delivery has wrong scope: %+v", avatar)
		}
	}
	if node, err := exec.LookPath("node"); err == nil {
		module, err := filepath.Abs("../client/windows/electron/protected-community-avatar.cjs")
		if err != nil {
			t.Fatal(err)
		}
		const verifyClient = `
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { verifyCommunityAvatarAudience, verifyCommunityAvatarPublisher } = require(process.argv[1]);
const { attestation, audience, avatar } = JSON.parse(readFileSync(0, 'utf8'));
const keys = verifyCommunityAvatarAudience(attestation, audience);
assert.equal(keys.length, 3);
assert.ok(keys.some(key => key.id === avatar.package.id));
const bad = structuredClone(audience);
bad.recipients[0].key.publicKey = 'd'.repeat(64);
assert.throws(() => verifyCommunityAvatarAudience(attestation, bad));
assert.throws(() => verifyCommunityAvatarAudience({ ...attestation, digest: 'f'.repeat(64) }, audience));
assert.equal(verifyCommunityAvatarPublisher(attestation, avatar.content.context, avatar.publisher), avatar.publisher.device.key.publicKey);
const impersonated = { ...avatar.content.context, deviceId: avatar.package.id };
assert.throws(() => verifyCommunityAvatarPublisher(attestation, impersonated, avatar.publisher));
assert.throws(() => verifyCommunityAvatarPublisher(attestation, avatar.content.context, { ...avatar.publisher, grants: [] }));`
		command := exec.CommandContext(ctx, node, "-e", verifyClient, module)
		hideWindow(command)
		command.Stdin = bytes.NewReader(encode(map[string]any{"audience": audience, "avatar": read(viewerToken), "attestation": map[string]any{
			"digest": anchor.Digest, "revision": anchor.Draft.Revision, "root": anchor.Draft.TextProjectionRoot,
			"projectionVersion": anchor.Draft.TextProjectionVersion}}))
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("Client audience and publisher proofs: %v\n%s", err, output)
		}
	} else {
		t.Log("Node unavailable for cross-language proof assertions")
	}
	initial.Roles["reader"] = access.Role{}
	intent := access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("e", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order}}
	var preview access.PolicyPreview
	if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", ownerToken, encode(intent), http.StatusOK), &preview); err != nil {
		t.Fatal(err)
	}
	var current access.PolicyProof
	if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/commit", ownerToken,
		encode(signTestPolicyDraft(t, server, owner, 1, preview.Draft)), http.StatusOK), &current); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPut, endpoint, editorToken, encode(update(editor, 2, 3, "f", current)), http.StatusForbidden)
	call(http.MethodGet, endpoint+"/audience", editorToken, nil, http.StatusForbidden)
	if saved := read(viewerToken); saved.Publisher == nil || saved.Content.Context.PolicyHead != anchor.Digest {
		t.Fatalf("the previous publisher's signed authority changed with the current policy: %+v", saved)
	}
	call(http.MethodPut, endpoint, ownerToken, encode(update(owner, 1, 3, "f", anchor)), http.StatusConflict)
	removal := update(owner, 1, 3, "f", current)
	removal.Packet, removal.Packages = nil, nil
	call(http.MethodPut, endpoint, ownerToken, encode(removal), http.StatusOK)
	if after := read(viewerToken); after != (access.CommunityAvatarView{Revision: 3}) {
		t.Fatalf("removed avatar remained visible: %+v", after)
	}
	audit := call(http.MethodGet, "/api/v3/audit", ownerToken, nil, http.StatusOK)
	if strings.Count(string(audit), `"action":"server.avatar"`) != 2 ||
		strings.Contains(string(audit), base64.StdEncoding.EncodeToString(first.Packet.Signature)) ||
		strings.Contains(string(audit), base64.StdEncoding.EncodeToString(first.Packet.Ciphertext)) {
		t.Fatalf("unexpected avatar audit: %s", audit)
	}
}
