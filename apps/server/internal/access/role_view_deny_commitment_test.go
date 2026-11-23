package access

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestRoleViewDenyCommitmentMatchesResolver(t *testing.T) {
	channel, sibling, category := strings.Repeat("9", 32), strings.Repeat("8", 32), strings.Repeat("7", 32)
	profile := func(id byte) string { return strings.Repeat(string(id), 64) }
	owner := profile('1')
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner, Order: []string{"blocked", "vip", "silent", "administrator", "latent"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView}}, "blocked": {}, "vip": {}, "silent": {}, "latent": {},
				"administrator": {Grants: []string{Administrator}},
			}},
			Members: make(map[string]Subject),
		},
		Channels: map[string]Channel{
			channel: {Kind: "text", CategoryID: category, Synchronized: true, NextPosition: 6},
			sibling: {Kind: "text", CategoryID: category, Synchronized: true, NextPosition: 6},
		},
		Categories: map[string]ACL{
			category: {
				Roles: map[string]Overwrite{
					"blocked": {Allow: []string{ChannelView, "message.pin"}}, "vip": {Allow: []string{ChannelView}},
					"latent": {Deny: []string{ChannelView}},
				},
				Profiles: map[string]Overwrite{profile('3'): {Allow: []string{ChannelView}}, profile('6'): {Deny: []string{ChannelView}}},
			},
		},
		Admissions: map[string]map[string]Admission{channel: {}}, KeyRecipients: make(map[string]KeyRecipient), PolicyDevices: make(map[string]PolicyDevice),
	}
	for _, example := range []struct {
		id    byte
		roles []string
	}{
		{'1', []string{"blocked"}}, {'2', []string{"blocked", "silent"}}, {'3', []string{"blocked"}},
		{'4', []string{"blocked", "vip"}}, {'5', []string{"blocked", "administrator"}}, {'6', []string{"blocked"}},
		{'8', []string{"blocked", "blocked"}}, {'9', []string{"latent"}}, {'a', []string{"vip"}}, {'b', []string{"silent"}},
	} {
		id := profile(example.id)
		state.Members[id] = Subject{ID: id, Roles: example.roles, Active: true}
		state.Admissions[channel][id] = Admission{FirstPosition: 1}
	}
	key := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(1))
	device := hexHash(parseScopeAuthorityKey(key))
	state.PolicyDevices[device] = PolicyDevice{ProfileID: owner, PublicKey: key}
	state.KeyRecipients[device] = KeyRecipient{ProfileID: owner, Kind: "device", PublicKey: strings.Repeat("c", 64)}

	scope := state.scope(state.Channels[channel])
	rules := scopedACLRoleRules(scope)
	before, err := channelACLRoleRulesDigest(rules)
	if err != nil {
		t.Fatal(err)
	}
	var seed [32]byte
	for i := range seed {
		seed[i] = 0xaa
	}
	root, _, err := state.roleViewDenyCommitment(channel, seed, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range state.Order {
		if slices.Contains(rules[role].Deny, ChannelView) {
			continue
		}
		nextRules := roleViewDenyRules(rules, role)
		next, err := channelACLRoleRulesDigest(nextRules)
		if err != nil {
			t.Fatal(err)
		}
		var excluded []string
		replacement := Scope{Kind: "text", Local: &ACL{Roles: nextRules, Profiles: scope.effectiveACL().Profiles}}
		for id, member := range state.Members {
			if state.CheckGrant(member, scope, ChannelView, 0) == Allowed && state.CheckGrant(member, replacement, ChannelView, 0) != Allowed {
				excluded = append(excluded, id)
			}
		}
		slices.Sort(excluded)
		pinnedRoot, proof, err := state.roleViewDenyCommitment(channel, seed, next)
		if err != nil || pinnedRoot != root || (proof != nil) != (len(excluded) != 0) {
			t.Fatalf("%s root/effect mismatch: %+v, %v", role, proof, err)
		}
		if proof == nil {
			continue
		}
		if !slices.Equal(excluded, proof.ExcludedProfiles) || proof.RoleID != role || proof.PreviousRulesDigest != before ||
			proof.NextRulesDigest != next || proof.Proof.Count != 3 || proof.Proof.Index < 0 || proof.Proof.Index >= proof.Proof.Count {
			t.Fatalf("%s exclude %v, got %+v", role, excluded, proof)
		}
		if role == "blocked" {
			if !slices.Equal(proof.ExcludedProfiles, []string{profile('2'), profile('8')}) ||
				proof.Salt != "d820013a0f2d60ccfa14860833ccc3179e9884aa54298d57ad837020d4899121" ||
				proof.NextRulesDigest != "44b8f05f99b4f47a95dc0b0d2f9b7971538bdfbb9abd07d8c820caff0c931199" {
				t.Errorf("blocked role vector = %+v", proof)
			}
		}
	}
	if root != "23025da480593b5770bccf21919c4363e1bcb34b2e15fb4d9997d2942eb6786f" ||
		before != "7c01fa0a523c75ea0fb35c5376fb38008126f8de9ae3de39cf8076a1af133642" {
		t.Errorf("predecessor rules %s, role effects root %s", before, root)
	}
	if unknownRoot, proof, err := state.roleViewDenyCommitment(channel, seed, strings.Repeat("f", 64)); err != nil || unknownRoot != root || proof != nil {
		t.Fatalf("unmatched intent got a witness: %+v %v", proof, err)
	}
	legacy, err := state.textRecipientCommitment(channel, seed, device, TextGroupedRevisionAudienceProjectionVersion, 1)
	if err != nil {
		t.Fatal(err)
	}
	current, err := state.textRecipientCommitment(channel, seed, device, TextRoleViewDenyProjectionVersion, 1)
	if err != nil || current.rotation == nil || current.rotation.RoleViewDenies != root || current.rotation.LimitedProfiles != legacy.rotation.LimitedProfiles {
		t.Fatalf("v16 text projection effect mismatch: %+v %v", current.rotation, err)
	}
	raw, err := json.Marshal(legacy.rotation)
	if err != nil || strings.Contains(string(raw), "roleViewDenies") ||
		current.root != "2318c4ecab20efb7e5b133678f0b455173c06bba0ad6c6e446f17f86abcc6450" {
		t.Errorf("v15 JSON %s, v16 channel digest %s, %v", raw, current.root, err)
	}
	if scope.effectiveACL().Roles["blocked"].Deny != nil || !state.Channels[sibling].Synchronized {
		t.Fatal("hypothetical scoped effect changed the category or sibling")
	}
}

func TestRoleViewDenyOversizedEffectRetainsRoot(t *testing.T) {
	channel := strings.Repeat("9", 32)
	state := State{RoleSnapshot: RoleSnapshot{
		Policy:  Policy{Roles: map[string]Role{Everyone: {Grants: []string{ChannelView}}, "limited": {}}},
		Members: make(map[string]Subject),
	}, Channels: map[string]Channel{channel: {Kind: "text"}}}
	for n := range maxRoleViewDenyWitness + 1 {
		id := fmt.Sprintf("%064x", n)
		state.Members[id] = Subject{ID: id, Roles: []string{"limited"}, Active: true}
	}
	candidate, err := channelACLRoleRulesDigest(roleViewDenyRules(scopedACLRoleRules(state.scope(state.Channels[channel])), "limited"))
	if err != nil {
		t.Fatal(err)
	}
	root, proof, err := state.roleViewDenyCommitment(channel, [32]byte{}, candidate)
	if err != nil || proof != nil || root == countedCommitmentRoot(0, [32]byte{}) {
		t.Fatalf("large effect lost its commitment or opened an oversized proof: %s %+v %v", root, proof, err)
	}
}
