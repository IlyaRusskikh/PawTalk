package access

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestGroupedRevisionAudiencePositionVectors(t *testing.T) {
	channel := strings.Repeat("9", 32)
	var seed [32]byte
	for i := range seed {
		seed[i] = 0xaa
	}
	statement := func(profile, recipient, key string, first uint64, archive bool) TextRecipientStatement {
		return TextRecipientStatement{
			TextChannelKeyRecipient: TextChannelKeyRecipient{ProfileID: strings.Repeat(profile, 64),
				RecipientID: strings.Repeat(recipient, 64), PublicKey: strings.Repeat(key, 64), Archive: archive},
			FirstPosition: first,
		}
	}
	statements := []TextRecipientStatement{
		statement("2", "f", "a", 12, false),
		statement("2", "e", "b", 12, false),
		statement("4", "d", "c", 29, false),
		statement("6", "c", "d", 12, false),
		statement("8", "b", "e", 1, true),
	}
	baseRoot, noPosition, err := groupedRevisionAudienceCommitment(channel, seed, statements, 0)
	if err != nil || noPosition != nil {
		t.Fatalf("root-only proof = %v %v", noPosition, err)
	}
	for _, test := range []struct {
		position uint64
		wantSalt string
	}{
		{11, "e4fedc491d00bf0f5c9690682ebfcd3e969d0e8304311fc5bfe73b0f8b5c2772"},
		{12, "16a64a73628f6d279638f28ca584c54ed3f894826cc82eb4833d207f843bd812"},
		{29, "49175e3531d4dc0a76633dc6f90d542b4e33e139c20838e9592254483bff7fe1"},
	} {
		root, proof, err := groupedRevisionAudienceCommitment(channel, seed, statements, test.position)
		if err != nil || proof == nil || root != baseRoot || len(proof.Siblings) != revisionAudienceDepth {
			t.Fatalf("position %d has wrong root or proof: %s %+v %v", test.position, root, proof, err)
		}
		if proof.Salt != test.wantSalt {
			t.Errorf("position %d salt = %s", test.position, proof.Salt)
		}
	}
	if baseRoot != "ee431fdc55e183915a10f747387559cef785da4df7e6aa64158feea35fbecef0" {
		t.Errorf("grouped root = %s", baseRoot)
	}
	reversed := slices.Clone(statements)
	slices.Reverse(reversed)
	if root, _, err := groupedRevisionAudienceCommitment(channel, seed, reversed, 0); err != nil || root != baseRoot {
		t.Fatalf("reordered profiles changed root: %s %v", root, err)
	}
	if root, _, err := groupedRevisionAudienceCommitment(channel, seed, statements[:4], 0); err != nil || root != baseRoot {
		t.Fatalf("archive-only profile changed limited revision root: %s %v", root, err)
	}
	divergent := slices.Clone(statements)
	divergent[1].FirstPosition++
	if _, _, err := groupedRevisionAudienceCommitment(channel, seed, divergent, 0); err != InvalidPolicy {
		t.Fatalf("divergent FirstPosition accepted: %v", err)
	}
}

func TestGroupedRevisionAudienceDisclosureVersion(t *testing.T) {
	channel, profile := strings.Repeat("9", 32), strings.Repeat("2", 64)
	key := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(1))
	device := hexHash(parseScopeAuthorityKey(key))
	state := State{
		RoleSnapshot: RoleSnapshot{Policy: Policy{Roles: map[string]Role{Everyone: {Grants: []string{ChannelView}}}},
			Members: map[string]Subject{profile: {ID: profile, Active: true}}},
		Channels:      map[string]Channel{channel: {Kind: "text", NextPosition: 9}},
		Admissions:    map[string]map[string]Admission{channel: {profile: {FirstPosition: 3}}},
		PolicyDevices: map[string]PolicyDevice{device: {ProfileID: profile, PublicKey: key}},
		KeyRecipients: map[string]KeyRecipient{device: {ProfileID: profile, Kind: "device", PublicKey: strings.Repeat("c", 64)}},
	}
	seed := strings.Repeat("aa", 32)
	var cache textChannelPolicyTreeCache
	disclose := func(version int, position uint64) *TextChannelPolicyDisclosure {
		t.Helper()
		root, err := state.textProjectionRoot(seed, version)
		if err != nil {
			t.Fatal(err)
		}
		head := PolicyProof{Digest: root, Draft: PolicyDraft{Revision: 2, TextProjectionVersion: version, TextProjectionRoot: root, TextProjectionSeed: seed}}
		proof, err := textChannelDisclosure(state, head, channel, device, &cache, position)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	legacy := disclose(TextGroupedArchiveRotationProjectionVersion, 6)
	newProof := disclose(TextGroupedRevisionAudienceProjectionVersion, 6)
	rootOnly := disclose(TextGroupedRevisionAudienceProjectionVersion, 0)
	if legacy.AudienceProof == nil || legacy.GroupedAudienceProof != nil || legacy.Rotation.LimitedProfiles != "" ||
		newProof.AudienceProof == nil || newProof.GroupedAudienceProof == nil || rootOnly.GroupedAudienceProof != nil ||
		newProof.Rotation.LimitedProfiles == "" || newProof.Rotation.LimitedProfiles != rootOnly.Rotation.LimitedProfiles ||
		newProof.LimitedAudience != legacy.LimitedAudience {
		t.Fatal("grouped proof changed the legacy position proof or leaked an unqueried proof")
	}
	raw, err := json.Marshal(legacy)
	if err != nil || strings.Contains(string(raw), "limitedProfiles") || strings.Contains(string(raw), "groupedAudienceProof") {
		t.Fatalf("new fields in v14: %s %v", raw, err)
	}
	if !HasTextRecipientProjection(TextGroupedRevisionAudienceProjectionVersion) ||
		!HasTextRecipientProjection(TextRoleViewDenyProjectionVersion) ||
		!HasTextRecipientProjection(TextNewcomerAdmissionProjectionVersion) ||
		!HasTextRecipientProjection(ProfileRoleAuthorityProjectionVersion) || HasTextRecipientProjection(ProfileRoleAuthorityProjectionVersion+1) {
		t.Fatal("unexpected supported projection range")
	}
}
