package access

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func assertScopedRoleViewDenyArchiveSources(t *testing.T, ctx context.Context, store *Store, claimant, limited ResolveSession,
	task RotationTask, live EpochRecord, claimantActor Principal, verify VerifyEpochRecord, cache *TextChannelPolicyProofCache, private ...string) {
	t.Helper()
	if task.RoleViewDeny == nil || live.LiveTransitionDigest == "" || len(task.ArchiveTargets) < 2 {
		t.Fatal("archive role fixture did not include an older and a marked source")
	}
	read := func(actor ResolveSession, scope *TextChannelPolicyProofCache) ([]EpochPackageDelivery, error) {
		var deliveries []EpochPackageDelivery
		err := store.DispatchRotationTargetPackages(ctx, actor, task.EpochRecord, task.ArchiveTargets, verify, scope,
			func(value []EpochPackageDelivery) error { deliveries = value; return nil })
		return deliveries, err
	}
	deliveries, err := read(claimant, cache)
	if err != nil || len(deliveries) != len(task.ArchiveTargets) {
		t.Fatalf("scoped role archive source delivery: %d, %v", len(deliveries), err)
	}
	found := false
	for _, delivery := range deliveries {
		if delivery.Epoch.Record.KeyID == live.KeyID {
			found = true
			if delivery.Epoch.Record.LiveTransitionDigest != live.LiveTransitionDigest || delivery.Package.RecipientID != claimantActor.DeviceID ||
				delivery.LivePersonalDeny != nil || delivery.ArchiveRoleViewDeny != nil || delivery.Epoch.ArchiveRoleViewDeny != nil {
				t.Fatalf("unexpected marked LIVE source shape: %+v", delivery)
			}
			assertCompactRoleViewDenyReadEvidence(t, delivery.LiveRoleViewDeny, task.RoleViewDeny, claimantActor,
				delivery.Epoch.Principal, LiveEpoch, private...)
		} else if delivery.Epoch.Record.Revision < live.Revision &&
			(delivery.LiveRoleViewDeny != nil || delivery.ArchiveRoleViewDeny != nil || delivery.Epoch.ArchiveRoleViewDeny != nil) {
			t.Fatal("older source received role transition proof")
		}
	}
	if !found {
		t.Fatal("marked LIVE generation was absent from the pinned archive sources")
	}
	plain, err := read(claimant, nil)
	if err != nil || len(plain) != len(deliveries) {
		t.Fatalf("unscoped archive source delivery: %d, %v", len(plain), err)
	}
	for _, delivery := range plain {
		if delivery.LiveRoleViewDeny != nil || delivery.ArchiveRoleViewDeny != nil || delivery.Epoch.ArchiveRoleViewDeny != nil {
			t.Fatal("unscoped archive source received role evidence")
		}
	}
	if leaked, err := read(limited, cache); !errors.Is(err, ChannelRestricted) || len(leaked) != 0 {
		t.Fatalf("limited reader obtained an archive source: %d %v", len(leaked), err)
	}
}

func assertScopedRoleViewDenyArchiveDeliveries(t *testing.T, ctx context.Context, store *Store, reader, limited, denied ResolveSession,
	record EpochRecord, readerActor, signer Principal, expected *RoleViewDenyRotationEvidence, verify VerifyEpochRecord,
	cache *TextChannelPolicyProofCache, private ...string) {
	t.Helper()
	read := func(actor ResolveSession, scoped bool) (EpochPackageDelivery, error) {
		var delivery EpochPackageDelivery
		err := store.DispatchCurrentEpochPackage(ctx, actor, record.ChannelID, ArchiveEpoch, verify, cache, scoped, nil,
			func(value EpochPackageDelivery) error { delivery = value; return nil })
		return delivery, err
	}
	current, err := read(reader, true)
	if err != nil || current.Epoch.Record.ArchiveTransitionDigest != record.ArchiveTransitionDigest || current.Epoch.Record.KeyID != record.KeyID ||
		current.Package.RecipientID != readerActor.DeviceID || current.ArchivePersonalDeny != nil || current.LiveRoleViewDeny != nil {
		t.Fatalf("scoped current role archive package: %v", err)
	}
	assertCompactRoleViewDenyReadEvidence(t, current.ArchiveRoleViewDeny, expected, readerActor, signer, ArchiveEpoch, private...)
	if plain, err := read(reader, false); err != nil || plain.ArchiveRoleViewDeny != nil || plain.Epoch.ArchiveRoleViewDeny != nil {
		t.Fatalf("unscoped current archive returned role proof: %v", err)
	}
	for _, actor := range []ResolveSession{limited, denied} {
		if _, err := read(actor, true); !errors.Is(err, ChannelRestricted) {
			t.Fatalf("ineligible reader obtained marked archive package: %v", err)
		}
	}
	if err := store.DispatchEpochProofPage(ctx, reader, record.ChannelID, ArchiveEpoch, record.Generation-1, record.Generation,
		verify, cache, func(proofs []EpochProof) error {
			if len(proofs) != 1 || proofs[0].Record.KeyID != record.KeyID || proofs[0].ArchivePersonalDeny != nil {
				t.Fatalf("wrong role archive proof page: %+v", proofs)
			}
			assertCompactRoleViewDenyReadEvidence(t, proofs[0].ArchiveRoleViewDeny, expected, readerActor, signer, ArchiveEpoch, private...)
			return nil
		}); err != nil {
		t.Fatal(err)
	}
	if err := store.DispatchArchiveLinks(ctx, reader, record.ChannelID, record.KeyID, verify, cache, func(delivery ArchiveLinkDelivery) error {
		if delivery.Epoch.Record.KeyID != record.KeyID || len(delivery.Links) == 0 || delivery.Epoch.ArchivePersonalDeny != nil {
			t.Fatalf("wrong archive link scope: %+v", delivery.Epoch)
		}
		assertCompactRoleViewDenyReadEvidence(t, delivery.Epoch.ArchiveRoleViewDeny, expected, readerActor, signer, ArchiveEpoch, private...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func assertCompactRoleViewDenyReadEvidence(t *testing.T, proof *RoleViewDenyReadEvidence, expected *RoleViewDenyRotationEvidence,
	reader, signer Principal, purpose string, private ...string) {
	t.Helper()
	if proof == nil || expected == nil || proof.PreviousHead != expected.PreviousHead || proof.SuccessorHead != expected.SuccessorHead ||
		proof.Actor != expected.Actor || proof.EditorProof != expected.EditorProof || !reflect.DeepEqual(proof.Effect, expected.Effect) ||
		proof.PreviousTextPolicy == nil || proof.PreviousTextPolicy.Recipient == nil ||
		proof.PreviousSignerTextPolicy == nil || proof.PreviousSignerTextPolicy.Recipient == nil {
		t.Fatalf("incomplete compact role proof: %+v", proof)
	}
	readerStatement, signerStatement := proof.PreviousTextPolicy.Recipient.Statement, proof.PreviousSignerTextPolicy.Recipient.Statement
	if readerStatement.RecipientID != reader.DeviceID || readerStatement.ProfileID != reader.ProfileID ||
		signerStatement.RecipientID != signer.DeviceID || signerStatement.ProfileID != signer.ProfileID ||
		purpose == ArchiveEpoch && (!readerStatement.Archive || !signerStatement.Archive) {
		t.Fatalf("role evidence opened unrelated recipient or signer: %+v %+v", readerStatement, signerStatement)
	}
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	for _, hidden := range append(private, `"survivorOpenings":`, `"removedGroups":`, `"rules":`, `"rulesSalt":`) {
		if hidden != "" && strings.Contains(string(raw), hidden) {
			t.Fatalf("compact proof leaked %q", hidden)
		}
	}
}
