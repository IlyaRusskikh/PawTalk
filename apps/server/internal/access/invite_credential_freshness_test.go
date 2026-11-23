package access

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestInviteProjectionKeepsChannelSlots(t *testing.T) {
	snapshot := State{Channels: make(map[string]Channel, channelPolicySlots-1)}
	for index := range channelPolicySlots - 1 {
		snapshot.Channels[fmt.Sprintf("%032x", index)] = Channel{Kind: "voice"}
	}
	for _, version := range []int{TextRoleViewDenyProjectionVersion, TextNewcomerAdmissionProjectionVersion, ProfileRoleAuthorityProjectionVersion} {
		tree, err := snapshot.textProjectionTree(strings.Repeat("aa", 32), version)
		if err != nil || len(tree.positions) != channelPolicySlots {
			t.Fatalf("v%d should retain %d channel slots: %v", version, channelPolicySlots-1, err)
		}
	}
}

func TestInviteAdmissionProjectionVectors(t *testing.T) {
	owner, channel := strings.Repeat("1", 64), strings.Repeat("9", 32)
	key := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(1))
	device := hexHash(parseScopeAuthorityKey(key))
	retired := strings.Repeat("8", 64)
	snapshot := State{
		RoleSnapshot: RoleSnapshot{
			Policy:  Policy{Owner: owner, Roles: map[string]Role{Everyone: {Grants: []string{ChannelView, "message.send"}}}},
			Members: map[string]Subject{owner: {ID: owner, Active: true}},
		},
		Channels:             map[string]Channel{channel: {Kind: "text", NextPosition: 1}},
		PolicyDevices:        map[string]PolicyDevice{device: {ProfileID: owner, PublicKey: key}},
		RetiredRecipientKeys: map[string]bool{retired: true},
	}
	for _, candidate := range []inviteCredential{{"profile", owner}, {"device", device}, {"agreement", retired}} {
		if _, _, err := snapshot.inviteCredentialCommitment(&candidate); !errors.Is(err, ErrInviteConflict) {
			t.Fatalf("known %s got a freshness proof: %v", candidate.kind, err)
		}
	}
	credentials, path, err := snapshot.inviteCredentialCommitment(&inviteCredential{"profile", strings.Repeat("f", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if withoutOpening, _, err := snapshot.inviteCredentialCommitment(nil); err != nil || withoutOpening != credentials {
		t.Fatalf("root changed when opening a proof: %v", err)
	}
	seedHex := strings.Repeat("aa", 32)
	policy, err := snapshot.textProjectionTree(seedHex, TextNewcomerAdmissionProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	var seed [32]byte
	for i := range seed {
		seed[i] = 0xaa
	}
	issuers, issuer, err := snapshot.inviteIssuerCommitment(seed, Principal{ProfileID: owner, DeviceID: device})
	if err != nil || issuer == nil {
		t.Fatalf("issuer proof: %+v %v", issuer, err)
	}
	opening, err := snapshot.inviteAdmissionScopeOpening(seed, TextNewcomerAdmissionProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	invite := strings.Repeat("3", 32)
	snapshot.InvitationUses = map[string]InvitePolicyUse{invite: {Count: 1, IssueSignature: "fixture-signature"}}
	used, _, err := snapshot.inviteCredentialCommitment(nil)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := inviteAdmissionFreshness(snapshot, InviteAdmissionScopeOpening{Credentials: used},
		Principal{ProfileID: strings.Repeat("f", 64), DeviceID: strings.Repeat("e", 64)},
		InviteRedeem{InviteID: invite, AgreementKey: strings.Repeat("d", 64)})
	if err != nil {
		t.Fatal(err)
	}
	count := fresh.Use
	if count.Count != 1 || count.IssueSignature != "fixture-signature" || len(count.Path) != 2 ||
		used != "a39061c56f890cbfb7d9b2f8b257e099913e4ca425a8094bfb52f2d2c20b1a44" {
		t.Fatalf("invite use commitment changed: %s %+v", used, count)
	}
	if credentials != "54c34a1d17e00056bc7a83957916f6032bb5c9662132ecca2c7d355bc06ebce4" ||
		issuers != "616c2688a731c2e19bbdb96fdb9010b012ffe9b0a47751af55899e5eeef87cee" ||
		opening.Ranks != "e11384d0677edeb1aa124f8dae11d46bfbf52279364b37221c98e189d9b3a920" ||
		policy.root() != "c7e06a18b3ac3624c3d7f6f9e0d420fbc789c7a94b647e33d6c854af23a46151" ||
		len(path) != 1 || path[0] != (InviteCredentialSibling{Depth: 0, Digest: "e9966f5cc5ffcbd67cb9b91f604c9918b8e3e707cc67fa1d76e758f560823860"}) {
		t.Fatalf("invite admission projections changed: %s %s %s %+v", credentials, issuers, policy.root(), path)
	}
	if !HasTextRecipientProjection(TextNewcomerAdmissionProjectionVersion) ||
		!HasTextRecipientProjection(ProfileRoleAuthorityProjectionVersion) || HasTextRecipientProjection(ProfileRoleAuthorityProjectionVersion+1) {
		t.Fatal("projection negotiation must end at v17")
	}
}

func TestInviteCredentialOpeningsMatchIndividualPaths(t *testing.T) {
	snapshot, requests := inviteCredentialOpeningFixture(32)
	root, paths, err := snapshot.inviteCredentialOpenings(requests)
	if err != nil || len(paths) != len(requests) {
		t.Fatalf("openings: %d paths, %v", len(paths), err)
	}
	for credential, absent := range requests {
		singleRoot, path, err := snapshot.inviteCredentialProof(&credential, absent)
		if err != nil || singleRoot != root || !slices.Equal(path, paths[credential]) {
			t.Fatalf("opening changed for %s: %v", credential.kind, err)
		}
	}
	for profile := range snapshot.Members {
		requests[inviteCredential{"profile", profile}] = true
		break
	}
	if _, _, err := snapshot.inviteCredentialOpenings(requests); !errors.Is(err, ErrInviteConflict) {
		t.Fatalf("batch accepted a known credential for an absence proof: %v", err)
	}
}

func BenchmarkInviteCredentialOpenings(b *testing.B) {
	snapshot, requests := inviteCredentialOpeningFixture(128)
	b.Run("separate", func(b *testing.B) {
		for range b.N {
			for credential, absent := range requests {
				if _, _, err := snapshot.inviteCredentialProof(&credential, absent); err != nil {
					b.Fatal(err)
				}
			}
		}
	})
	b.Run("batch", func(b *testing.B) {
		for range b.N {
			if _, _, err := snapshot.inviteCredentialOpenings(requests); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func inviteCredentialOpeningFixture(count int) (State, map[inviteCredential]bool) {
	snapshot := State{RoleSnapshot: RoleSnapshot{Members: make(map[string]Subject)}, InvitationUses: make(map[string]InvitePolicyUse)}
	requests := make(map[inviteCredential]bool)
	for i := range count {
		profile := hexHash([]byte(fmt.Sprintf("member %d", i)))
		snapshot.Members[profile] = Subject{ID: profile, Active: true}
		requests[inviteCredential{"profile", hexHash([]byte(fmt.Sprintf("applicant %d", i)))}] = true
		id := fmt.Sprintf("%032x", i)
		requests[inviteCredential{"invite-use", id}] = false
		if i%2 == 0 {
			snapshot.InvitationUses[id] = InvitePolicyUse{Count: int64(i) + 1, IssueSignature: "fixture"}
		}
	}
	return snapshot, requests
}
