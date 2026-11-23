package access

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"testing"
)

func personalDenyBatchEpochFrame(record EpochRecord) []byte {
	record.Signature = nil
	encoded, _ := json.Marshal(record)
	return encoded
}

func extendPersonalDenyLiveBacklog(t *testing.T, ctx context.Context, db *sql.DB, store *Store, owner ResolveSession,
	actor Principal, initial EpochRecord, packages []EpochPackage, key ed25519.PrivateKey) {
	t.Helper()
	verify := func(_ context.Context, _ SessionQuery, principal Principal, record EpochRecord) error {
		if principal != actor || !ed25519.Verify(key.Public().(ed25519.PublicKey), personalDenyBatchEpochFrame(record), record.Signature) {
			return ErrEpochConflict
		}
		return nil
	}
	for generation := initial.Generation + 1; generation <= archiveBatchSize; generation++ {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := enqueueRotation(ctx, tx, initial.ChannelID, LiveEpoch, initial.Revision, actor.ProfileID, store.now().UnixMilli()); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		task, err := store.ClaimRotation(ctx, owner, initial.ChannelID, LiveEpoch)
		if err != nil || task.Generation != generation {
			t.Fatalf("claim synthetic live generation %d: %+v %v", generation, task.EpochRecord, err)
		}
		record := task.EpochRecord
		record.PackagesDigest = initial.PackagesDigest
		record.KeyID = hexHash([]byte("test live batch generation " + strconv.FormatUint(generation, 10)))
		record.Signature = ed25519.Sign(key, personalDenyBatchEpochFrame(record))
		if err := store.CommitEpoch(ctx, owner, verify, record, packages, nil); err != nil {
			t.Fatalf("publish synthetic live generation %d: %v", generation, err)
		}
	}
}

func commitFirstPersonalDenyArchiveBatch(t *testing.T, ctx context.Context, store *Store, claim RotationTask, resolve ResolveSession,
	verify VerifyEpochRecord, key ed25519.PrivateKey) EpochRecord {
	t.Helper()
	if claim.ArchivePersonalDeny == nil || claim.Generation != 1 || claim.ArchiveThrough != archiveBatchSize || len(claim.ArchiveTargets) != int(archiveBatchSize) {
		t.Fatalf("first marked archive batch was not capped: generation=%d through=%d, targets=%d", claim.Generation, claim.ArchiveThrough, len(claim.ArchiveTargets))
	}
	record := claim.EpochRecord
	record.KeyID = hexHash([]byte("test first marked archive batch"))
	record.ArchiveWrapKey = recoveryTestAgreementKey(t, 9)
	var packages []EpochPackage
	for id := range claim.Recipients {
		packages = append(packages, EpochPackage{RecipientID: id, Purpose: ArchiveEpoch, Ciphertext: make([]byte, EpochPackageSize)})
	}
	var links []ArchiveLink
	for _, target := range claim.ArchiveTargets {
		links = append(links, ArchiveLink{ArchiveTarget: target, Ciphertext: make([]byte, ArchiveLinkSize)})
	}
	var err error
	record.PackagesDigest, err = PackagesDigest(packages)
	if err != nil {
		t.Fatal(err)
	}
	record.ArchiveLinksDigest, err = ArchiveLinksDigest(links)
	if err != nil {
		t.Fatal(err)
	}
	record.ArchiveTransitionDigest, err = personalDenyTransitionDigest(record, *claim.ArchivePersonalDeny)
	if err != nil {
		t.Fatal(err)
	}
	record.Signature = ed25519.Sign(key, personalDenyBatchEpochFrame(record))
	if err := store.CommitEpoch(ctx, resolve, verify, record, packages, links); err != nil {
		t.Fatal(err)
	}
	return record
}

func assertMarkedArchiveProofPage(t *testing.T, ctx context.Context, store *Store, resolve ResolveSession, reader Principal,
	first, second EpochRecord, verify VerifyEpochRecord, scope *TextChannelPolicyProofCache, expected bool) {
	t.Helper()
	if second.PreviousDigest != hexHash(first.Signature) || first.Revision != second.Revision || first.ArchiveTransitionDigest != second.ArchiveTransitionDigest {
		t.Fatal("archive batches did not form one signed transition chain")
	}
	var proofs []EpochProof
	read := func(through uint64) error {
		proofs = nil
		return store.DispatchEpochProofPage(ctx, resolve, first.ChannelID, ArchiveEpoch, 0, through, verify, scope,
			func(page []EpochProof) error { proofs = page; return nil })
	}
	if err := read(second.Generation); err != nil || len(proofs) != 2 {
		t.Fatalf("two marked archive proofs: %d %v", len(proofs), err)
	}
	for _, proof := range proofs {
		witness := proof.ArchivePersonalDeny
		if (witness != nil) != expected {
			t.Fatalf("unexpected witness for generation %d: %+v", proof.Record.Generation, witness)
		}
		if witness != nil && (witness.PreviousTextPolicy.Recipient.Statement.RecipientID != reader.DeviceID ||
			witness.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != proof.Principal.DeviceID) {
			t.Fatalf("unbound archive reader/signer: %+v", witness)
		}
	}
	if expected && proofs[0].ArchivePersonalDeny != proofs[1].ArchivePersonalDeny {
		t.Fatal("archive proof page rebuilt a witness for the same signer and transition")
	}
	if err := read(second.Generation + 1); !errors.Is(err, ErrEpochStale) || len(proofs) != 0 {
		t.Fatalf("future proof page: %d %v", len(proofs), err)
	}
	var links ArchiveLinkDelivery
	err := store.DispatchArchiveLinks(ctx, resolve, first.ChannelID, first.KeyID, verify, scope,
		func(value ArchiveLinkDelivery) error { links = value; return nil })
	if err != nil || links.Epoch.Record.Generation != first.Generation || (links.Epoch.ArchivePersonalDeny != nil) != expected ||
		len(links.Links) != int(archiveBatchSize) {
		t.Fatalf("older capped archive links: %d %v", len(links.Links), err)
	}
}
