package access

import (
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestProfileRankCommitmentV11Vectors(t *testing.T) {
	owner, actor, target, other := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64)
	inactive, alias := strings.Repeat("5", 64), strings.Repeat("6", 64)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner, Order: []string{"guest", "editor"}},
			Members: map[string]Subject{
				owner: {ID: owner, Active: true}, actor: {ID: actor, Active: true, Roles: []string{"editor"}},
				target: {ID: target, Active: true, Roles: []string{"guest"}}, other: {ID: other, Active: true},
				inactive: {ID: inactive}, alias: {ID: alias, Active: true},
			},
		},
		ProfileBindings: map[string]string{alias: owner},
	}
	var seed [32]byte
	for i := range seed {
		seed[i] = 0xaa
	}
	empty, err := (State{}).profileRankCommitment(seed, ProfileRankProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	tree, err := state.textProjectionTree(strings.Repeat("aa", 32), ProfileRankProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	proof := func(id string, want int) ProfileRankProof {
		t.Helper()
		result, err := tree.ranks.proof(id)
		if err != nil || result.Rank != want || result.ProfileID != id || result.BypassesACL != nil {
			t.Fatalf("profile rank proof = %+v, %v", result, err)
		}
		previous := -1
		for _, sibling := range result.Path {
			if sibling.Bit <= previous || sibling.Bit > 255 || !isDigest(sibling.Digest) {
				t.Fatalf("unexpected compressed path: %+v", result.Path)
			}
			previous = sibling.Bit
		}
		return result
	}
	actorProof, targetProof := proof(actor, 2), proof(target, 1)
	proof(owner, 3)
	proof(other, 0)
	if len(tree.ranks.leaves) != 4 {
		t.Fatal("inactive or aliased subject included in the rank tree")
	}
	legacy, err := state.textProjectionTree(strings.Repeat("aa", 32), ChannelACLProjectionVersion)
	if err != nil || legacy.ranks != nil {
		t.Fatalf("v10 unexpectedly includes profile rank data: %v", err)
	}
	if _, err := legacy.proof(profileRankProjectionID); err != ChannelRestricted {
		t.Fatalf("v10 returned profile rank inclusion: %v", err)
	}
	inclusion, err := tree.proof(profileRankProjectionID)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(ChannelACLRankBasis{Root: tree.ranks.digest, Inclusion: inclusion, Actor: actorProof, Target: targetProof})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "bypassesACL") {
		t.Fatalf("v11 encoded the v12 bypass field: %s", raw)
	}
	for _, id := range []string{owner, other, inactive, alias} {
		if strings.Contains(string(raw), id) {
			t.Fatalf("rank basis leaked another profile ID: %s", id)
		}
	}
	for _, vector := range []struct{ label, got, want string }{
		{"empty", empty.digest, "c96106a2e86d7e0388f05f85cb9b329a6bbebd2337a7fed3b9750ba3c0208924"},
		{"rank tree", tree.ranks.digest, "afc6f9bcd037fcfc95dbe86a932beee2cd2ad076edf4520e78ab0cdcf00a4d05"},
		{"policy tree", tree.root(), "ae854c87a0aa6e12356ba0877ce9be6082b91d64ec5601e23c4c2963bc6e5a55"},
		{"actor salt", actorProof.Salt, "f678069d4463958c10ce188993cbc87e8b97314ee58a25e1b8a68f6d94735470"},
		{"target salt", targetProof.Salt, "dc4fe10f6f5e0a9290168821d8fa84969fdbe705b3dc4c80be650c5216b8bdc9"},
	} {
		if vector.got != vector.want {
			t.Errorf("%s = %s, want %s", vector.label, vector.got, vector.want)
		}
	}
	if inclusion.Index != 388 {
		t.Fatalf("virtual leaf index = %d, want 388", inclusion.Index)
	}
	first := ProfileRankSibling{Bit: 0, Digest: "f22ff9ecbef87d482cac8c1070f993485c58275df67a465657ab899952adf19c"}
	second := ProfileRankSibling{Bit: 1, Digest: "e591fdf2c1f7b0041d6dbc53e9996e8fa32508a248b9c8964136c12490ef954e"}
	actorLeaf := ProfileRankSibling{Bit: 2, Digest: "ed1af29d405a38f66f0fdf590140800af62c885e264d3596b7d0859199952396"}
	targetLeaf := ProfileRankSibling{Bit: 2, Digest: "62fac64d548c11c5f0b1609fd51c7be8dcf42b10628b7dbf42e8cb45ec54d2c1"}
	if !slices.Equal(actorProof.Path, []ProfileRankSibling{first, second, actorLeaf}) ||
		!slices.Equal(targetProof.Path, []ProfileRankSibling{first, second, targetLeaf}) {
		t.Fatalf("unexpected path for actor or target: %+v, %+v", actorProof.Path, targetProof.Path)
	}
	delete(state.Members, owner)
	delete(state.Members, other)
	pair, err := state.profileRankCommitment(seed, ProfileRankProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	short, err := pair.proof(actor)
	if err != nil || !slices.Equal(short.Path, []ProfileRankSibling{actorLeaf}) {
		t.Fatalf("shared prefix did not compress: %+v, %v", short, err)
	}
}

func TestProfileACLBypassV12Vectors(t *testing.T) {
	owner, editor, admin, member := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64)
	state := State{RoleSnapshot: RoleSnapshot{
		Policy: Policy{Owner: owner, Order: []string{"guest", "editor"}, Roles: map[string]Role{"guest": {Grants: []string{Administrator}}}},
		Members: map[string]Subject{
			owner: {ID: owner, Active: true}, editor: {ID: editor, Active: true, Roles: []string{"editor"}},
			admin: {ID: admin, Active: true, Roles: []string{"guest"}}, member: {ID: member, Active: true},
		},
	}}
	seed := strings.Repeat("aa", 32)
	tree, err := state.textProjectionTree(seed, ProfileACLBypassProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		id   string
		rank int
		want bool
	}{
		{owner, 3, true}, {editor, 2, false}, {admin, 1, true}, {member, 0, false},
	} {
		proof, err := tree.ranks.proof(test.id)
		if err != nil || proof.Rank != test.rank || proof.BypassesACL == nil || *proof.BypassesACL != test.want {
			t.Fatalf("profile %s: unexpected rank or bypass proof %+v, %v", test.id, proof, err)
		}
		raw, err := json.Marshal(proof)
		if err != nil || !strings.Contains(string(raw), `"bypassesACL":`+strconv.FormatBool(test.want)) {
			t.Fatalf("v12 did not serialize its explicit bypass fact: %s, %v", raw, err)
		}
	}
	previous, err := state.textProjectionTree(seed, ProfileRankProjectionVersion)
	if err != nil || previous.root() != "ae854c87a0aa6e12356ba0877ce9be6082b91d64ec5601e23c4c2963bc6e5a55" {
		t.Fatalf("v11 root changed: %v, %v", previous, err)
	}
	state.Roles["guest"] = Role{}
	removed, err := state.textProjectionTree(seed, ProfileACLBypassProjectionVersion)
	if err != nil || removed.ranks.digest == tree.ranks.digest {
		t.Fatalf("Administrator privilege changed without changing the v12 commitment: %v", err)
	}
	adminAfter, err := removed.ranks.proof(admin)
	if err != nil || adminAfter.Rank != 1 || adminAfter.BypassesACL == nil || *adminAfter.BypassesACL {
		t.Fatalf("bypass flag persisted without Administrator: %+v, %v", adminAfter, err)
	}
	state.Roles[Everyone] = Role{Grants: []string{Administrator}}
	baseline, err := state.textProjectionTree(seed, ProfileACLBypassProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	memberWithBaseline, err := baseline.ranks.proof(member)
	if err != nil || memberWithBaseline.Rank != 0 || memberWithBaseline.BypassesACL == nil || !*memberWithBaseline.BypassesACL {
		t.Fatalf("base Administrator missing from bypass proof: %+v, %v", memberWithBaseline, err)
	}
	if tree.ranks.digest != "a933599b1a6b735dee6b85f714369bdab37621fddb66297223eb6fd898331149" ||
		tree.root() != "194b057e0e27c0cb19557a1043a86929b0a6a3597aefd3565c95e6929570f7a8" {
		t.Fatalf("v12 rank or outer policy root changed: %s, %s", tree.ranks.digest, tree.root())
	}
}
