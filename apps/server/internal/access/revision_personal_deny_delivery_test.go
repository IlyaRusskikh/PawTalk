package access

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func publishPersonalDenyEditedOriginal(t *testing.T, ctx context.Context, store *Store, resolve ResolveSession,
	author, archiveSigner Principal, key ed25519.PrivateKey, channel, target string, position uint64, verifyEpoch VerifyEpochRecord,
	cache *TextChannelPolicyProofCache, removed bool, privateRecipients ...string) VerifyRevision {
	t.Helper()
	var basis RevisionBasis
	if err := store.DispatchRevisionBasis(ctx, resolve, verifyEpoch, nil, channel, position, cache,
		func(value RevisionBasis) error { basis = value; return nil }); err != nil {
		t.Fatal(err)
	}
	if basis.Archive.Record.ArchiveTransitionDigest == "" || len(basis.Recipients) == 0 {
		t.Fatal("test requires a marked archive basis and at least one limited recipient")
	}
	assertOfflineRevisionWriterAudience(t, basis, author, archiveSigner, target, removed, privateRecipients...)
	return commitProtectedRevisionFixture(t, ctx, store, resolve, author, key, channel, position, basis, verifyEpoch)
}

func commitProtectedRevisionFixture(t *testing.T, ctx context.Context, store *Store, resolve ResolveSession, author Principal,
	key ed25519.PrivateKey, channel string, position uint64, basis RevisionBasis, verifyEpoch VerifyEpochRecord) VerifyRevision {
	t.Helper()
	attempt := RevisionAttempt{RevisionExpectation: basis.RevisionExpectation, OperationID: strings.Repeat("7", 32),
		Packet: RevisionPacket{Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), ArchivePackage: make([]byte, EpochPackageSize)}}
	for _, recipient := range basis.Recipients {
		attempt.Packages = append(attempt.Packages, RevisionPackage{RevisionRecipient: recipient, Ciphertext: make([]byte, EpochPackageSize)})
	}
	root, _, err := revisionPackageTree(attempt.Packages, -1)
	if err != nil {
		t.Fatal(err)
	}
	attempt.Packet.RecipientDigest = root
	frame := func(candidateBasis RevisionBasis, candidate RevisionAttempt) ([]byte, error) {
		return SignatureFrame("test-protected-revision", channel, candidateBasis.Original, candidate.OperationID,
			candidate.PolicyDigest, candidate.ArchiveDigest, candidate.Packet.RecipientDigest)
	}
	message, err := frame(basis, attempt)
	if err != nil {
		t.Fatal(err)
	}
	attempt.Packet.Signature = ed25519.Sign(key, message)
	verify := func(_ context.Context, _ SessionQuery, signer Principal, candidateChannel string,
		candidateBasis RevisionBasis, candidate RevisionAttempt) error {
		message, err := frame(candidateBasis, candidate)
		if err != nil || signer != author || candidateChannel != channel ||
			!ed25519.Verify(key.Public().(ed25519.PublicKey), message, candidate.Packet.Signature) {
			return ErrRevisionConflict
		}
		return nil
	}
	if receipt, err := store.CommitRevision(ctx, resolve, verifyEpoch, verify, nil, channel, position, attempt); err != nil || receipt.Revision != basis.Revision {
		t.Fatalf("commit revision: %+v %v", receipt, err)
	}
	return verify
}

func assertPersonalDenyEditedOriginalRead(t *testing.T, ctx context.Context, store *Store, full, limited, denied ResolveSession,
	reader, author, signer Principal, channel string, position uint64, previous, successor PolicyProof,
	verifyEpoch VerifyEpochRecord, verify VerifyRevision, cache *TextChannelPolicyProofCache, privateRecipients ...string) {
	t.Helper()
	read := func(resolve ResolveSession, scoped *TextChannelPolicyProofCache) (RevisionDelivery, error) {
		var delivery RevisionDelivery
		err := store.DispatchRevision(ctx, resolve, verifyEpoch, verify, nil, channel, position, scoped,
			func(value RevisionDelivery) error { delivery = value; return nil })
		return delivery, err
	}
	for _, test := range []struct {
		resolve   ResolveSession
		addressed bool
	}{{full, false}, {limited, true}} {
		revision, err := read(test.resolve, cache)
		if err != nil {
			t.Fatal(err)
		}
		proof := revision.PersonalDeny
		if proof == nil || proof.PreviousRevision != previous.Draft.Revision || proof.PreviousHead != previous.Digest ||
			proof.SuccessorHead != successor.Digest || revision.Record.PolicyRevision != successor.Draft.Revision ||
			proof.PreviousTextPolicy.Recipient.Statement.RecipientID != author.DeviceID ||
			proof.PreviousTextPolicy.Recipient.Statement.CanSend == nil || !*proof.PreviousTextPolicy.Recipient.Statement.CanSend ||
			proof.PreviousTextPolicy.GroupedAudienceProof != nil || proof.PreviousTextPolicy.AudienceProof != nil ||
			proof.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != signer.DeviceID || !proof.PreviousSignerTextPolicy.Recipient.Statement.Archive {
			t.Fatalf("incorrect revision author/archive-signer witness: %+v", proof)
		}
		if test.addressed {
			if revision.Package == nil || revision.Proof == nil || revision.Package.ID != reader.DeviceID || proof.PreviousRecipientPolicy == nil ||
				proof.PreviousRecipientPolicy.Recipient.Statement.RecipientID != reader.DeviceID || proof.PreviousRecipientPolicy.Recipient.Statement.Archive {
				t.Fatalf("missing addressed limited reader proof: %+v", proof.PreviousRecipientPolicy)
			}
		} else if revision.Package != nil || revision.Proof != nil || proof.PreviousRecipientPolicy != nil {
			t.Fatal("full-history reader obtained a limited reader package or witness")
		}
		encoded, err := json.Marshal(proof)
		if err != nil || !strings.Contains(string(encoded), `"previousTextPolicy":`) {
			t.Fatalf("invalid revision witness JSON: %s %v", encoded, err)
		}
		privateFields := []string{`"groupedAudience":`, `"groupedAudienceProof":`, `"removedGroup":`, `"survivorOpenings":`, `"rules":`}
		for _, private := range append(privateFields, privateRecipients...) {
			if strings.Contains(string(encoded), private) {
				t.Fatalf("stored revision leaked a historical audience opening or unrelated recipient: %s", private)
			}
		}
	}
	if unscoped, err := read(limited, nil); err != nil || unscoped.Package == nil || unscoped.PersonalDeny != nil {
		t.Fatalf("unscoped revision proof changed: %+v %v", unscoped, err)
	}
	if rejected, err := read(denied, cache); !errors.Is(err, ChannelRestricted) || rejected.PersonalDeny != nil || rejected.Package != nil {
		t.Fatalf("denied reader obtained the revision: %+v %v", rejected, err)
	}
}
