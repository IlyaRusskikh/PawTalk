package access

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

func TestScopedRoleProfileAuthorityOpening(t *testing.T) {
	const (
		actor  = "1111111111111111111111111111111111111111111111111111111111111111"
		target = "2222222222222222222222222222222222222222222222222222222222222222"
		other  = "3333333333333333333333333333333333333333333333333333333333333333"
	)
	device, recovery, unrelated := strings.Repeat("4", 64), strings.Repeat("5", 64), strings.Repeat("6", 64)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: other, Order: []string{"reader", "actor"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView}},
				"reader": {Grants: []string{"history.full"}},
				"actor":  {Grants: []string{"role.assign"}},
			}},
			Members: map[string]Subject{
				actor:  {ID: actor, Active: true, Roles: []string{"actor"}},
				target: {ID: target, Active: true, Roles: []string{"reader"}},
				other:  {ID: other, Active: true},
			},
		},
		PolicyDevices: map[string]PolicyDevice{
			device:    {ProfileID: target, PublicKey: strings.Repeat("a", 64)},
			unrelated: {ProfileID: other, PublicKey: strings.Repeat("b", 64)},
		},
		KeyRecipients: map[string]KeyRecipient{
			device:   {ProfileID: target, Kind: "device", PublicKey: strings.Repeat("c", 64)},
			recovery: {ProfileID: target, Kind: "recovery", PublicKey: strings.Repeat("d", 64)},
		},
	}
	var seed [32]byte
	for i := range seed {
		seed[i] = 0x42
	}
	legacy, err := state.profileRankCommitment(seed, TextNewcomerAdmissionProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	tree, err := state.profileRankCommitment(seed, ProfileRoleAuthorityProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	rank, err := tree.proof(target)
	if err != nil {
		t.Fatal(err)
	}
	legacyRank, err := legacy.proof(target)
	if err != nil || legacyRank.RoleAuthority != "" || tree.digest == legacy.digest || !HasTextRecipientProjection(ProfileRoleAuthorityProjectionVersion) {
		t.Fatalf("role authority changed the negotiated v17 contract: %+v / %v", legacyRank, err)
	}
	opening := state.profileRoleAuthority(seed, state.Members[target], scopedRoleKeys(state)[target])
	components, err := opening.parts()
	if err != nil {
		t.Fatal(err)
	}
	digest, err := opening.digest()
	if err != nil || digest != rank.RoleAuthority || len(opening.Keys) != 3 || opening.RolesSalt == rank.Salt || opening.KeysSalt == opening.RolesSalt {
		t.Fatalf("profile opening was not bound by a separately blinded rank leaf: %+v, %v", rank, err)
	}
	encodedRank, err := json.Marshal(rank)
	if err != nil || bytes.Contains(encodedRank, []byte(unrelated)) || bytes.Contains(encodedRank, []byte(opening.KeysSalt)) ||
		bytes.Contains(encodedRank, []byte("history.full")) {
		t.Fatalf("rank proof disclosed private role data: %s, %v", encodedRank, err)
	}
	t.Run("client-verification", func(t *testing.T) {
		node, err := exec.LookPath("node")
		if err != nil {
			t.Skip("Node is required for cross-language profile proof verification")
		}
		payload, err := json.Marshal(map[string]any{"state": state, "seed": hex.EncodeToString(seed[:]), "root": tree.digest,
			"revisionProtocol": ProfileRoleAuthorityProjectionVersion, "target": target, "proof": rank, "opening": opening, "other": other,
			"components": components})
		if err != nil {
			t.Fatal(err)
		}
		command := exec.Command(node, "-e", `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { profileRankRoot, verifyProfileRoleAuthority } = require('../../../client/windows/electron/protected-policy-profile-ranks.cjs');
const { state, seed, root, revisionProtocol, target, proof, opening, other, components } = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.equal(profileRankRoot(state, seed, revisionProtocol), root);
const read = (data, id = target, witness = proof, expectedRoot = root) => verifyProfileRoleAuthority(expectedRoot, id, witness, data);
const valid = read(opening);
assert.deepEqual(valid.grants, ['channel.view', 'history.full']);
assert.deepEqual(valid.roles, ['reader']);
assert.equal(valid.keys.length, 3);
const bad = { code: 'INVALID_PROFILE_RANK_PROOF' };
const partial = { grants: opening.grants, grantsSalt: opening.grantsSalt };
const unopened = { roles: components.roles, keys: components.keys, recoveryReady: components.recoveryReady };
assert.deepEqual(verifyProfileRoleAuthority(root, target, proof, partial, unopened),
  { rank: 1, bypassesACL: false, keyRoot: components.keys, grants: opening.grants });
assert.throws(() => verifyProfileRoleAuthority(root, target, proof, partial, { ...unopened, keys: '0'.repeat(64) }), bad);
assert.throws(() => verifyProfileRoleAuthority(root, target, proof, partial, components), bad);
assert.throws(() => read({ ...opening, roles: ['actor'] }), bad);
assert.throws(() => read({ ...opening, grants: [...opening.grants, 'role.assign'] }), bad);
assert.throws(() => read({ ...opening, keys: opening.keys.slice(1) }), bad);
assert.throws(() => read({ ...opening, keys: opening.keys.map(key => ({ ...key, publicKey: '0'.repeat(64) })) }), bad);
assert.throws(() => read(opening, other), bad);
assert.throws(() => read(opening, target, { ...proof, rank: proof.rank + 1 }), bad);
assert.throws(() => read(opening, target, proof, 'f'.repeat(64)), bad);
`)
		command.Stdin = bytes.NewReader(payload)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("Electron profile opening verification: %v\n%s", err, output)
		}
	})
}
