package access

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func assertScopedPersonalDenyArchiveSource(t *testing.T, ctx context.Context, store *Store, claimant, limited ResolveSession,
	task RotationTask, live EpochRecord, claimantActor Principal, deniedProfile string, verify VerifyEpochRecord,
	cache *TextChannelPolicyProofCache, privateRecipients ...string) {
	t.Helper()
	targets := task.ArchiveTargets
	if len(targets) != 2 || targets[1] != (ArchiveTarget{Purpose: LiveEpoch, Generation: live.Generation, KeyID: live.KeyID}) {
		t.Fatalf("expected both archive sources and newest live target, got %+v", targets)
	}
	read := func(resolve ResolveSession, record EpochRecord, selected []ArchiveTarget, scope *TextChannelPolicyProofCache) ([]EpochPackageDelivery, error) {
		var deliveries []EpochPackageDelivery
		err := store.DispatchRotationTargetPackages(ctx, resolve, record, selected, verify, scope,
			func(values []EpochPackageDelivery) error { deliveries = values; return nil })
		return deliveries, err
	}
	deliveries, err := read(claimant, task.EpochRecord, targets, cache)
	if err != nil || len(deliveries) != 2 {
		t.Fatalf("scoped archive source delivery: %d, %v", len(deliveries), err)
	}
	old := deliveries[0]
	if old.LivePersonalDeny != nil || old.ArchivePersonalDeny != nil {
		t.Fatal("older source received a package-level transition witness")
	}
	if targets[0].Purpose == ArchiveEpoch {
		proof := old.Epoch.ArchivePersonalDeny
		if proof == nil || proof.SuccessorHead != task.ArchivePersonalDeny.SuccessorHead ||
			proof.PreviousTextPolicy.Recipient.Statement.RecipientID != claimantActor.DeviceID ||
			proof.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != old.Epoch.Principal.DeviceID {
			t.Fatalf("uncertified marked archive source: %+v", proof)
		}
		assertCompactPersonalDenyReadWitness(t, proof, privateRecipients)
	} else if old.Epoch.ArchivePersonalDeny != nil {
		t.Fatal("older live source received an archive transition witness")
	}
	marked := deliveries[1]
	proof := marked.LivePersonalDeny
	if marked.ArchivePersonalDeny != nil || marked.Package.RecipientID != claimantActor.DeviceID ||
		marked.Epoch.Record.LiveTransitionDigest != live.LiveTransitionDigest || proof == nil ||
		proof.PreviousHead != task.ArchivePersonalDeny.PreviousHead || proof.SuccessorHead != task.ArchivePersonalDeny.SuccessorHead ||
		proof.TargetProfileID != deniedProfile || proof.PreviousTextPolicy.Recipient.Statement.RecipientID != claimantActor.DeviceID ||
		proof.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != marked.Epoch.Principal.DeviceID {
		t.Fatalf("incorrect scoped live source witness: %+v", marked)
	}
	assertCompactPersonalDenyReadWitness(t, proof, privateRecipients)
	plain, err := read(claimant, task.EpochRecord, targets, nil)
	if err != nil || len(plain) != 2 || plain[1].LivePersonalDeny != nil || plain[1].ArchivePersonalDeny != nil || plain[0].Epoch.ArchivePersonalDeny != nil {
		t.Fatalf("unscoped target response contained a witness: %+v %v", plain, err)
	}
	if leaked, err := read(limited, task.EpochRecord, targets, cache); !errors.Is(err, ChannelRestricted) || len(leaked) != 0 {
		t.Fatalf("limited recipient obtained an archive target: %d %v", len(leaked), err)
	}
	stale := task.EpochRecord
	stale.Revision--
	if leaked, err := read(claimant, stale, targets, cache); !errors.Is(err, ErrPolicyConflict) || len(leaked) != 0 {
		t.Fatalf("stale revision obtained an archive target: %d %v", len(leaked), err)
	}
	wrongTarget := targets[1]
	wrongTarget.KeyID = strings.Repeat("b", 64)
	if leaked, err := read(claimant, task.EpochRecord, []ArchiveTarget{wrongTarget}, cache); !errors.Is(err, ErrEpochRecipients) || len(leaked) != 0 {
		t.Fatalf("unleased source obtained an archive target: %d %v", len(leaked), err)
	}
}

func assertScopedPersonalDenyArchiveRead(t *testing.T, ctx context.Context, store *Store, reader, limited, denied ResolveSession,
	record EpochRecord, readerActor, signerActor Principal, transition *PersonalDenyRotationEvidence, verify VerifyEpochRecord,
	cache *TextChannelPolicyProofCache, privateRecipients ...string) {
	t.Helper()
	load := func(resolve ResolveSession, scoped bool) (EpochPackageDelivery, error) {
		var delivery EpochPackageDelivery
		err := store.DispatchCurrentEpochPackage(ctx, resolve, record.ChannelID, ArchiveEpoch, verify, cache, scoped, nil,
			func(value EpochPackageDelivery) error { delivery = value; return nil })
		return delivery, err
	}
	addressed, err := load(reader, true)
	if err != nil {
		t.Fatal(err)
	}
	proof := addressed.ArchivePersonalDeny
	if addressed.LivePersonalDeny != nil || addressed.Package.RecipientID != readerActor.DeviceID ||
		addressed.Epoch.Principal != signerActor || addressed.Epoch.Record.ArchiveTransitionDigest != record.ArchiveTransitionDigest ||
		proof == nil || proof.PreviousRevision != transition.PreviousRevision || proof.PreviousHead != transition.PreviousHead ||
		proof.SuccessorHead != transition.SuccessorHead || proof.TargetProfileID != transition.TargetProfileID ||
		proof.PreviousTextPolicy.Recipient.Statement.RecipientID != readerActor.DeviceID || !proof.PreviousTextPolicy.Recipient.Statement.Archive ||
		proof.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != signerActor.DeviceID || !proof.PreviousSignerTextPolicy.Recipient.Statement.Archive {
		t.Fatalf("incorrect archive reader witness: %+v", addressed)
	}
	assertCompactPersonalDenyReadWitness(t, proof, privateRecipients)
	if plain, err := load(reader, false); err != nil || plain.ArchivePersonalDeny != nil || plain.LivePersonalDeny != nil {
		t.Fatalf("unscoped archive reader response contained a witness: %+v %v", plain, err)
	}
	for _, actor := range []ResolveSession{limited, denied} {
		if forbidden, err := load(actor, true); !errors.Is(err, ChannelRestricted) || forbidden.ArchivePersonalDeny != nil || forbidden.Package.RecipientID != "" {
			t.Fatalf("ineligible reader received an archive package: %+v %v", forbidden, err)
		}
	}
}

func assertCompactPersonalDenyReadWitness(t *testing.T, proof *PersonalDenyReadEvidence, privateRecipients []string) {
	t.Helper()
	encoded, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	privateFields := []string{`"survivorOpenings":`, `"removedGroup":`, `"rules":`}
	for _, private := range append(privateFields, privateRecipients...) {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("read/shared witness disclosed private historical material: %s", private)
		}
	}
}
