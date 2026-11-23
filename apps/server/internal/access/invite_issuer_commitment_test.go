package access

import (
	"crypto/ed25519"
	"encoding/binary"
	"encoding/hex"
	"slices"
	"strings"
	"testing"
)

func TestInviteIssuerCommitmentVector(t *testing.T) {
	owner, inviter, admin := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64)
	manager, inactive, alias := strings.Repeat("4", 64), strings.Repeat("5", 64), strings.Repeat("6", 64)
	state := State{RoleSnapshot: RoleSnapshot{
		Policy: Policy{Owner: owner, Roles: map[string]Role{
			"inviter": {Grants: []string{"invite.create"}},
			"admin":   {Grants: []string{Administrator}},
			"manager": {Grants: []string{"invite.view-all", "invite.manage-all"}},
		}},
		Members: map[string]Subject{
			owner:    {ID: owner, Active: true},
			inviter:  {ID: inviter, Active: true, Roles: []string{"inviter"}, TimeoutUntil: 10_000},
			admin:    {ID: admin, Active: true, Roles: []string{"admin"}},
			manager:  {ID: manager, Active: true, Roles: []string{"manager"}},
			inactive: {ID: inactive, Roles: []string{"inviter"}},
			alias:    {ID: alias, Roles: []string{"inviter"}},
		},
	}, PolicyDevices: make(map[string]PolicyDevice), ProfileBindings: map[string]string{alias: inviter}}
	profiles := []string{owner, owner, inviter, admin, manager, inactive, owner, alias}
	actors := make([]Principal, len(profiles))
	for i, profile := range profiles {
		key := scopeAuthorityTestKey(byte(i + 1)).Public().(ed25519.PublicKey)
		device := hexHash(key)
		actors[i] = Principal{ProfileID: profile, DeviceID: device}
		state.PolicyDevices[device] = PolicyDevice{ProfileID: profile, PublicKey: hex.EncodeToString(key), Revoked: i == 6}
	}
	var seed [32]byte
	for i := range seed {
		seed[i] = 7
	}
	// Expected root and path calculated independently with Node crypto.
	const expectedRoot = "19f8d76234d04afea59fb88e6626d1c307ed376d37820d93829585b66f939a23"
	expectedPath := []string{
		"71f8739bea862bd0cda9eb262302a3dee4803689bfdd5b56a8449a11b479f111",
		"5dfcf2e385076289a7d25cbc1039ec8b0d6fe5c1faae10abbbad0200835cdd3b",
	}
	root, witness, err := state.inviteIssuerCommitment(seed, actors[2])
	if err != nil || root != expectedRoot || witness == nil ||
		witness.SigningKey != state.PolicyDevices[actors[2].DeviceID].PublicKey ||
		witness.Salt != "40a363dbcc02e74a80d0bf0bf9d0a7c5ca51c5c526b2ebf652953bf963b6ee92" ||
		witness.Proof.Count != 4 || witness.Proof.Index != 0 || !slices.Equal(witness.Proof.Siblings, expectedPath) {
		t.Fatalf("unexpected invite issuer vector: root %s, witness %+v, err %v", root, witness, err)
	}
	for _, actor := range append(actors[4:], Principal{ProfileID: owner, DeviceID: actors[2].DeviceID}, Principal{}) {
		root, witness, err := state.inviteIssuerCommitment(seed, actor)
		if err != nil || root != expectedRoot || witness != nil {
			t.Fatalf("unexpected proof for %+v: root %s, witness %+v, err %v", actor, root, witness, err)
		}
	}
	state.PolicyDevices[actors[2].DeviceID] = PolicyDevice{ProfileID: inviter, PublicKey: strings.Repeat("0", 64)}
	if _, _, err := state.inviteIssuerCommitment(seed, actors[2]); err != InvalidPolicy {
		t.Fatalf("invalid signing key binding was accepted: %v", err)
	}
}

func TestInviteIssuerCommitmentProofBound(t *testing.T) {
	profile := strings.Repeat("a", 64)
	state := State{RoleSnapshot: RoleSnapshot{
		Policy:  Policy{Owner: profile},
		Members: map[string]Subject{profile: {ID: profile, Active: true}},
	}, PolicyDevices: make(map[string]PolicyDevice)}
	var seed [32]byte
	var target Principal
	var lastDevice string
	for i := 0; i <= maxInviteIssuerProofCount; i++ {
		binary.BigEndian.PutUint32(seed[:4], uint32(i))
		key := ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)
		lastDevice = hexHash(key)
		state.PolicyDevices[lastDevice] = PolicyDevice{ProfileID: profile, PublicKey: hex.EncodeToString(key)}
		if i == 0 {
			target = Principal{ProfileID: profile, DeviceID: lastDevice}
		}
	}
	fullRoot, witness, err := state.inviteIssuerCommitment(seed, target)
	if err != nil || !isDigest(fullRoot) || witness != nil {
		t.Fatalf("oversized tree root %s, witness %+v, err %v", fullRoot, witness, err)
	}
	delete(state.PolicyDevices, lastDevice)
	boundedRoot, witness, err := state.inviteIssuerCommitment(seed, target)
	if err != nil || fullRoot == boundedRoot || witness == nil || witness.Proof.Count != maxInviteIssuerProofCount {
		t.Fatalf("bounded tree root %s, witness %+v, err %v", boundedRoot, witness, err)
	}
}
