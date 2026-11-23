package access

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"
)

func testRoleDenyStoredRevision(t *testing.T, ctx context.Context, store *Store, resolve func(string) ResolveSession, actors map[string]Principal,
	owner, editor, signer, limited, firstTarget, secondTarget, keyless, late string, position uint64, archive EpochRecord,
	transition *RoleViewDenyRotationEvidence, archiveTarget bool, publish func(int64), verifyPolicy VerifyPolicyDraft,
	verifyEpoch VerifyEpochRecord, cache *TextChannelPolicyProofCache) {
	t.Helper()
	channel := archive.ChannelID
	var basis RevisionBasis
	if err := store.DispatchRevisionBasis(ctx, resolve(editor), verifyEpoch, nil, channel, position, cache,
		func(value RevisionBasis) error { basis = value; return nil }); err != nil {
		t.Fatal(err)
	}
	proof := basis.RoleViewDeny
	if proof == nil || proof.GroupedAudience == nil || basis.PersonalDeny != nil || basis.Position != position ||
		basis.Archive.Record.KeyID != archive.KeyID || basis.Archive.Record.ArchiveTransitionDigest != archive.ArchiveTransitionDigest ||
		proof.PreviousTextPolicy == nil || proof.PreviousTextPolicy.Recipient == nil || proof.PreviousTextPolicy.GroupedAudienceProof == nil ||
		len(proof.PreviousTextPolicy.GroupedAudienceProof.Siblings) != 53 || proof.PreviousSignerTextPolicy == nil ||
		proof.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != actors[signer].DeviceID ||
		!slices.Equal(proof.Effect.ExcludedProfiles, []string{firstTarget, secondTarget, keyless}) {
		t.Fatalf("invalid marked archive revision writer basis: %+v", proof)
	}
	expectedRecipients := map[string]string{actors[editor].DeviceID: editor, actors[limited].DeviceID: limited}
	if len(basis.Recipients) != len(expectedRecipients) || !maps.Equal(proof.GroupedAudience.Profiles, expectedRecipients) ||
		len(proof.GroupedAudience.Openings) != len(expectedRecipients) {
		t.Fatalf("writer received wrong original-position audience: %+v", proof.GroupedAudience)
	}
	state, _, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, recipient := range basis.Recipients {
		if expectedRecipients[recipient.ID] == "" || state.KeyRecipients[recipient.ID].PublicKey != recipient.PublicKey {
			t.Fatalf("unexpected limited package recipient: %+v", recipient)
		}
	}
	wantRemoved := []string{secondTarget}
	if !archiveTarget {
		wantRemoved = append(wantRemoved, firstTarget)
	}
	if len(proof.RemovedGroups) != len(wantRemoved) {
		t.Fatalf("incorrect removed limited groups: %+v", proof.RemovedGroups)
	}
	var priorSeed [32]byte
	for i := range priorSeed {
		priorSeed[i] = 0xee
	}
	for _, profile := range wantRemoved {
		id := actors[profile].DeviceID
		opening := textRevisionProfileOpening(priorSeed, channel, profile)
		oldDigest, err := textRevisionProfileMembersDigest([][2]string{{id, state.KeyRecipients[id].PublicKey}}, opening.ContentSalt)
		if err != nil || proof.RemovedGroups[profile] != (LivePersonalDenyRemovedGroup{Salt: opening.Salt, Digest: oldDigest}) {
			t.Fatalf("wrong removed revision group for %s: %+v %v", profile, proof.RemovedGroups[profile], err)
		}
	}
	private := []string{actors[firstTarget].DeviceID, actors[secondTarget].DeviceID, actors[late].DeviceID,
		textRevisionProfileOpening(priorSeed, channel, firstTarget).ContentSalt, textRevisionProfileOpening(priorSeed, channel, secondTarget).ContentSalt}
	assertRoleRevisionRedaction(t, basis, private...)
	verify := commitProtectedRevisionFixture(t, ctx, store, resolve(editor), actors[editor], scopeAuthorityTestKey(2), channel, position, basis, verifyEpoch)
	read := func(profile string, scoped *TextChannelPolicyProofCache) (RevisionDelivery, error) {
		var delivery RevisionDelivery
		err := store.DispatchRevision(ctx, resolve(profile), verifyEpoch, verify, nil, channel, position, scoped,
			func(value RevisionDelivery) error { delivery = value; return nil })
		return delivery, err
	}
	assertRevision := func() {
		t.Helper()
		for _, profile := range []string{owner, limited} {
			delivery, err := read(profile, cache)
			readProof := delivery.RoleViewDeny
			if err != nil || readProof == nil || delivery.PersonalDeny != nil || delivery.Record.Revision != basis.Revision ||
				delivery.Record.Archive.Record.KeyID != archive.KeyID || readProof.SuccessorHead != transition.SuccessorHead ||
				readProof.PreviousHead != transition.PreviousHead || readProof.PreviousTextPolicy == nil ||
				readProof.PreviousTextPolicy.Recipient.Statement.RecipientID != actors[editor].DeviceID ||
				!readProof.PreviousSignerTextPolicy.Recipient.Statement.Archive ||
				readProof.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != actors[signer].DeviceID ||
				readProof.PreviousTextPolicy.GroupedAudienceProof != nil || readProof.PreviousTextPolicy.AudienceProof != nil {
				t.Fatalf("stored role revision lost immutable reader proof: %+v %v", readProof, err)
			}
			if profile == limited {
				if delivery.Package == nil || delivery.Proof == nil || delivery.Package.ID != actors[limited].DeviceID ||
					readProof.PreviousRecipientPolicy == nil || readProof.PreviousRecipientPolicy.Recipient == nil ||
					readProof.PreviousRecipientPolicy.Recipient.Statement.RecipientID != actors[limited].DeviceID ||
					readProof.PreviousRecipientPolicy.Recipient.Statement.Archive {
					t.Fatalf("limited reader received no addressed historical proof: %+v", delivery)
				}
			} else if delivery.Package != nil || delivery.Proof != nil || readProof.PreviousRecipientPolicy != nil {
				t.Fatal("full-history reader received a limited packet or opening")
			}
			assertRoleRevisionRedaction(t, delivery, append(private,
				`"groupedAudience":`, `"groupedAudienceProof":`, `"removedGroups":`, `"survivorOpenings":`)...)
		}
		for _, profile := range []string{firstTarget, secondTarget, late} {
			if delivery, err := read(profile, cache); !errors.Is(err, ChannelRestricted) || delivery.RoleViewDeny != nil || delivery.Package != nil {
				t.Fatalf("excluded or late viewer received original revision: %+v %v", delivery, err)
			}
		}
		if unscoped, err := read(limited, nil); err != nil || unscoped.Package == nil || unscoped.RoleViewDeny != nil {
			t.Fatalf("unscoped response changed: %+v %v", unscoped, err)
		}
	}
	assertRevision()
	acl := state.Channels[channel].ACL
	acl.Profiles = maps.Clone(acl.Profiles)
	delete(acl.Profiles, late)
	later, err := store.PreviewPolicy(ctx, resolve(owner), PolicyDraft{Action: UpdateChannelACL, OperationID: strings.Repeat("5", 32),
		ResourceChange: &PolicyResourceChange{ID: channel, ACL: &acl}})
	if err != nil {
		t.Fatal(err)
	}
	later.Signature = make([]byte, 64)
	later.Signature[0] = 3
	advanced, err := store.CommitPolicy(ctx, resolve(owner), verifyPolicy, later)
	if err != nil {
		t.Fatal(err)
	}
	publish(advanced.Draft.Revision)
	state, _, err = store.Snapshot(ctx)
	if err != nil || !state.CanDeliver(late, channel, 0) || state.CanDeliver(late, channel, position) ||
		state.ArchiveHeads[channel] != archive.Generation {
		t.Fatalf("later signed policy did not preserve the old epoch and limit the new reader: %v", err)
	}
	assertRevision()
}

func assertRoleRevisionRedaction(t *testing.T, value any, private ...string) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	for _, hidden := range private {
		if strings.Contains(string(raw), hidden) {
			t.Fatalf("revision response disclosed historical recipient material: %s", hidden)
		}
	}
}
