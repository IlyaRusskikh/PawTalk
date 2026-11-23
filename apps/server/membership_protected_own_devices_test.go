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
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedOwnDevicesAndProfileAvatarTLS(t *testing.T) {
	const avatarPath = "/api/v3/profiles/self/avatar"
	ctx := t.Context()
	server := testMembershipStore(t)
	var phone memberSession
	store, _, owner, outsider := protectedTestStateWith(t, server, func(state *access.State) {
		state.Channels = map[string]access.Channel{strings.Repeat("7", 32): {Kind: "text", NextPosition: 1}}
		phone.Access.DeviceID = publicKeyID(newTestMemberSigner(3).device.Public().(ed25519.PublicKey))
		phone.Access.EffectiveProfileID = state.Owner
		state.PolicyDevices[phone.Access.DeviceID] = access.PolicyDevice{ProfileID: state.Owner, PublicKey: testSigningKey(3)}
		state.KeyRecipients[phone.Access.DeviceID] = access.KeyRecipient{ProfileID: state.Owner, Kind: "device", PublicKey: testRecipientKey(t, 33)}
	})
	anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.ProfileRoleAuthorityProjectionVersion)
	ownerToken, phoneToken, outsiderToken := open(owner, 1), open(phone, 3), open(outsider, 2)
	encode := func(value any) []byte {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	ids := []string{owner.Access.DeviceID, phone.Access.DeviceID}
	slices.Sort(ids)
	var audience access.CommunityAvatarAudience
	if err := json.Unmarshal(call(http.MethodGet, avatarPath+"/audience", ownerToken, nil, http.StatusOK), &audience); err != nil ||
		len(audience.Recipients) != 2 || audience.Recipients[0].ID != ids[0] || audience.Recipients[1].ID != ids[1] {
		t.Fatalf("unexpected profile recipient scope: %+v (%v)", audience.Recipients, err)
	}
	binding := access.CommunityAvatarContext{ServerID: runtime.serverID, Revision: 2, Operation: strings.Repeat("2", 32),
		PolicyHead: anchor.Digest, ProfileID: owner.Access.EffectiveProfileID, DeviceID: owner.Access.DeviceID, Scope: "profile"}
	packet := &access.CommunityAvatarPacket{Nonce: bytes.Repeat([]byte{1}, 12), Ciphertext: bytes.Repeat([]byte{2}, 17),
		KeyCommitment: strings.Repeat("a", 64)}
	frame, err := access.SignatureFrame("pawtalk-community-avatar-signature-v1", binding.ServerID, "2", binding.Operation,
		binding.PolicyHead, binding.ProfileID, binding.DeviceID, binding.Scope, packet.KeyCommitment,
		base64.RawURLEncoding.EncodeToString(packet.Nonce), publicKeyID(packet.Ciphertext))
	if err != nil {
		t.Fatal(err)
	}
	packet.Signature = ed25519.Sign(newTestMemberSigner(1).device, frame)
	change := access.CommunityAvatarUpdate{Context: binding, Packet: packet}
	for _, id := range ids {
		change.Packages = append(change.Packages, access.CommunityAvatarPackage{ID: id, Ciphertext: bytes.Repeat([]byte{3}, 80)})
	}
	call(http.MethodPut, avatarPath, outsiderToken, encode(change), http.StatusForbidden)
	call(http.MethodPut, "/api/v3/community/avatar", ownerToken, encode(change), http.StatusBadRequest)
	call(http.MethodPut, avatarPath, ownerToken, encode(change), http.StatusOK)
	var published access.ProfileAvatarView
	if err := json.Unmarshal(call(http.MethodGet, avatarPath, phoneToken, nil, http.StatusOK), &published); err != nil ||
		published.Revision != 2 || published.Content == nil || published.Package == nil || published.Package.ID != phone.Access.DeviceID {
		t.Fatalf("linked device did not receive its avatar package: %+v (%v)", published, err)
	}
	if outsider := call(http.MethodGet, avatarPath, outsiderToken, nil, http.StatusOK); string(bytes.TrimSpace(outsider)) != `{"revision":1}` {
		t.Fatalf("another profile obtained avatar content or a key package: %s", outsider)
	}

	revoke := func(actor memberSession, seed byte, token, target, op string, status int) {
		t.Helper()
		intent := access.PolicyDraft{Action: access.RevokePolicyDevice, OperationID: strings.Repeat(op, 32),
			DeviceChange: &access.PolicyDeviceChange{DeviceID: target}}
		var preview access.PolicyPreview
		if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", token, encode(intent), http.StatusOK), &preview); err != nil {
			t.Fatal(err)
		}
		signed := signTestPolicyDraft(t, server, actor, seed, preview.Draft)
		if node, err := exec.LookPath("node"); err == nil {
			module, err := filepath.Abs("../client/windows/electron/protected-policy-checkpoint.cjs")
			if err != nil {
				t.Fatal(err)
			}
			const clientCheck = `
const assert = require('node:assert/strict');
const { createPrivateKey, sign } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { runtimePolicyPreviewFrame } = require(process.argv[1]);
const { preview, intent, trust, actor, previous, seed, signature, expectedFrame } = JSON.parse(readFileSync(0, 'utf8'));
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64')]),
  format: 'der', type: 'pkcs8'
});
runtimePolicyPreviewFrame(preview, intent, trust, actor, previous).then(frame => {
  assert.equal(Buffer.from(frame).toString('hex'), Buffer.from(expectedFrame, 'base64').toString('hex'));
  assert.equal(sign(null, frame, privateKey).toString('base64'), signature);
}).catch(error => { console.error(error); process.exitCode = 1; });`
			var snapshot []byte
			if err := server.db.QueryRow("SELECT snapshot FROM protected_policy_proofs WHERE revision=1").Scan(&snapshot); err != nil {
				t.Fatal(err)
			}
			command := exec.CommandContext(ctx, node, "-e", clientCheck, module)
			hideWindow(command)
			principal := access.Principal{ProfileID: actor.Access.EffectiveProfileID, DeviceID: actor.Access.DeviceID}
			expectedFrame, err := protectedPolicyFrame(runtime.serverID, principal, signed)
			if err != nil {
				t.Fatal(err)
			}
			command.Stdin = bytes.NewReader(encode(map[string]any{
				"preview": preview, "intent": intent, "signature": signed.Signature,
				"seed": newTestMemberSigner(seed).device.Seed(), "expectedFrame": expectedFrame,
				"actor": principal,
				"trust": map[string]any{"serverId": runtime.serverID},
				"previous": map[string]any{"complete": true, "snapshot": snapshot, "revision": 1, "digest": anchor.Digest,
					"textProjectionVersion": anchor.Draft.TextProjectionVersion},
			}))
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("client could not verify and sign device revocation: %v\n%s", err, output)
			}
		}
		call(http.MethodPost, "/api/v3/policy/commit", token, encode(signed), status)
	}
	revoke(phone, 3, phoneToken, owner.Access.DeviceID, "3", http.StatusConflict)
	revoke(owner, 1, ownerToken, phone.Access.DeviceID, "4", http.StatusOK)
	if body := call(http.MethodGet, avatarPath, phoneToken, nil, http.StatusForbidden); !bytes.Contains(body, []byte(`"PROTECTED_DEVICE_REVOKED"`)) {
		t.Fatalf("active session did not report confirmed revocation: %s", body)
	}
	call(http.MethodGet, avatarPath, ownerToken, nil, http.StatusOK)
	call(http.MethodGet, "/api/v3/state", outsiderToken, nil, http.StatusOK)
	result := call(http.MethodGet, "/api/v3/devices/self", ownerToken, nil, http.StatusOK)
	if bytes.Contains(result, []byte(phone.Access.DeviceID)) || !bytes.Contains(result, []byte(owner.Access.DeviceID)) {
		t.Fatalf("revoked devices were not isolated: %s", result)
	}
}
