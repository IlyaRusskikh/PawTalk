package access

import (
	"encoding/json"
	"strings"
	"testing"
)

func assertOfflineRevisionWriterAudience(t *testing.T, basis RevisionBasis, writer, archiveSigner Principal,
	target string, removed bool, private ...string) {
	t.Helper()
	proof := basis.PersonalDeny
	if proof == nil || proof.TargetProfileID != target || proof.PreviousRevision != basis.PolicyRevision-1 ||
		proof.PreviousTextPolicy == nil || proof.PreviousTextPolicy.Recipient == nil ||
		proof.PreviousTextPolicy.Recipient.Statement.RecipientID != writer.DeviceID ||
		proof.PreviousTextPolicy.Recipient.Statement.ProfileID != writer.ProfileID ||
		proof.PreviousTextPolicy.Recipient.Statement.CanSend == nil || !*proof.PreviousTextPolicy.Recipient.Statement.CanSend ||
		proof.PreviousTextPolicy.AudienceProof != nil || proof.PreviousTextPolicy.GroupedAudienceProof == nil ||
		proof.PreviousTextPolicy.Rotation == nil || proof.PreviousTextPolicy.Rotation.LimitedProfiles == "" ||
		proof.PreviousSignerTextPolicy == nil || proof.PreviousSignerTextPolicy.Recipient == nil ||
		proof.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != archiveSigner.DeviceID ||
		proof.PreviousSignerTextPolicy.Recipient.Statement.ProfileID != archiveSigner.ProfileID ||
		!proof.PreviousSignerTextPolicy.Recipient.Statement.Archive || basis.Archive.Principal != archiveSigner ||
		!isDigest(basis.Archive.Record.ArchiveWrapKey) || !isDigest(basis.Archive.Record.ArchiveTransitionDigest) ||
		basis.Archive.Record.Revision != basis.PolicyRevision || basis.Archive.Record.PolicyDigest != basis.PolicyDigest {
		t.Fatalf("incorrect marked archive binding for v15 revision writer: %+v", proof)
	}
	if (proof.RemovedGroup != nil) != removed ||
		proof.RemovedGroup != nil && (!isDigest(proof.RemovedGroup.Salt) || !isDigest(proof.RemovedGroup.Digest)) {
		t.Fatalf("incorrect removed group at original position %d: %+v", basis.Position, proof.RemovedGroup)
	}
	audience := proof.GroupedAudience
	if audience == nil || len(audience.Profiles) != len(basis.Recipients) {
		t.Fatal("old openings did not cover exactly the visible survivor recipients")
	}
	seen := make(map[string]bool)
	for _, recipient := range basis.Recipients {
		profile := audience.Profiles[recipient.ID]
		opening := audience.Openings[profile]
		if !isDigest(profile) || profile == target || !isDigest(opening.Salt) || !isDigest(opening.ContentSalt) {
			t.Fatalf("wrong revision survivor opening: %q", profile)
		}
		seen[profile] = true
	}
	if len(audience.Openings) != len(seen) {
		t.Fatal("v15 writer received unrelated group openings")
	}
	raw, err := json.Marshal(basis)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range private {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("v15 writer received unrelated recipient information: %s", secret)
		}
	}
}

func TestHistoricalRevisionPositionAllowsFullHistoryBeforeAdmission(t *testing.T) {
	profile, channel := strings.Repeat("a", 64), strings.Repeat("9", 32)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy:  Policy{Roles: map[string]Role{Everyone: {Grants: []string{ChannelView, "history.full"}}}},
			Members: map[string]Subject{profile: {ID: profile, Active: true}},
		},
		// Historical signed snapshots omit NextPosition.
		Channels:   map[string]Channel{channel: {Kind: "text"}},
		Admissions: map[string]map[string]Admission{channel: {profile: {FirstPosition: 5}}},
	}
	if !canReadRevisionPosition(state, channel, profile, 3) {
		t.Fatal("historical cursor prevented authorized full-history revision")
	}
	state.Roles[Everyone] = Role{Grants: []string{ChannelView}}
	if canReadRevisionPosition(state, channel, profile, 3) || !canReadRevisionPosition(state, channel, profile, 5) {
		t.Fatal("historical limited reader was not checked against original position")
	}
}
