package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestPolicyAttestationsAfterScopeAuthorityTransfer(t *testing.T) {
	ctx := context.Background()
	db, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	genesisKey, replacementKey, recoveryKey, readerKey := scopeAuthorityTestKey(31), scopeAuthorityTestKey(32), scopeAuthorityTestKey(33), scopeAuthorityTestKey(34)
	ownerID, readerID := strings.Repeat("a", 64), strings.Repeat("b", 64)
	principal := func(profile string, key ed25519.PrivateKey) Principal {
		return Principal{ProfileID: profile, DeviceID: hexHash(key.Public().(ed25519.PublicKey))}
	}
	genesis, replacement, reader := principal(ownerID, genesisKey), principal(ownerID, replacementKey), principal(readerID, readerKey)
	state := State{RoleSnapshot: RoleSnapshot{
		Policy:  Policy{Owner: ownerID, Roles: map[string]Role{Everyone: {Grants: []string{ChannelView}}}},
		Members: map[string]Subject{ownerID: {ID: ownerID, Active: true}, readerID: {ID: readerID, Active: true}},
	}, PolicyDevices: make(map[string]PolicyDevice), KeyRecipients: make(map[string]KeyRecipient)}
	addDevice := func(actor Principal, key ed25519.PrivateKey, seed byte) {
		state.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: actor.ProfileID, PublicKey: scopeAuthorityTestPublicKey(key)}
		state.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, seed)}
	}
	addDevice(genesis, genesisKey, 41)
	addDevice(reader, readerKey, 42)
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	state.PolicyAnchored = true
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	ops := func(revision int64) string { return fmt.Sprintf("%032x", revision) }
	root := strings.Repeat("c", 64)
	insertProof := func(actor Principal, revision int64, previous string, action string, change *PolicyResourceChange) PolicyProof {
		t.Helper()
		// The fixture supplies policy records directly so the test can focus on
		// attestation authorization and storage across an already applied recovery.
		snapshot, err := json.Marshal(state)
		if err != nil {
			t.Fatal(err)
		}
		signedSnapshot, err := state.policySnapshotBytes()
		if err != nil {
			t.Fatal(err)
		}
		draft := PolicyDraft{Action: action, OperationID: ops(revision), Revision: revision, PreviousDigest: previous,
			ResultDigest: hexHash(signedSnapshot), TextProjectionRoot: root, TextProjectionSeed: strings.Repeat("d", 64),
			TextProjectionVersion: VoiceRecipientProjectionVersion, ResourceChange: change, Signature: bytes.Repeat([]byte{byte(revision)}, 64)}
		proof := PolicyProof{Principal: actor, Draft: draft, Digest: hexHash(draft.Signature)}
		record, err := json.Marshal(proof)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO protected_policy_proofs(revision,operation_id,digest,snapshot,record) VALUES(?,?,?,?,?)`,
			revision, draft.OperationID, proof.Digest, signedSnapshot, record); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`UPDATE protected_policy SET revision=?,snapshot=? WHERE id=1`, revision, snapshot); err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := insertProof(genesis, 1, "", AnchorPolicy, nil)
	binding := ScopeAuthorityBinding{ServerID: strings.Repeat("e", 32), CutoverDigest: strings.Repeat("f", 64)}
	chainBinding := ScopeAuthorityContext{ServerID: binding.ServerID, CutoverDigest: binding.CutoverDigest,
		AnchorDigest: anchor.Digest, OwnerProfileID: ownerID, OwnerDeviceID: genesis.DeviceID}
	verify := func(_ context.Context, _ SessionQuery, actor Principal, anchorDigest string, view PolicyAttestation) error {
		t.Helper()
		frame, err := PolicyAttestationFrame(binding.ServerID, anchorDigest, actor, view)
		if err != nil {
			return err
		}
		key, err := hex.DecodeString(view.SignerKey)
		if err != nil || hexHash(key) != actor.DeviceID || !ed25519.Verify(key, frame, view.Signature) {
			return ErrPolicySignatureRequired
		}
		return nil
	}
	signAttestation := func(actor Principal, key ed25519.PrivateKey, target PolicyProof, authority *ScopeAuthorityLink) []byte {
		t.Helper()
		view := PolicyAttestation{Revision: target.Draft.Revision, Digest: target.Digest, Previous: target.Draft.PreviousDigest, PolicyDigest: target.Draft.ResultDigest,
			Root: target.Draft.TextProjectionRoot, ProjectionVersion: target.Draft.TextProjectionVersion}
		if authority != nil {
			var err error
			if authority.Action == TransferPolicyOwnership {
				view.AuthorityHead, err = ScopeOwnershipLinkDigest(chainBinding, ownerID, *authority)
				view.SignerProfileID = actor.ProfileID
			} else {
				view.AuthorityHead, err = ScopeAuthorityLinkDigest(chainBinding, *authority)
			}
			if err != nil {
				t.Fatal(err)
			}
			view.AuthorityRevision, view.SignerDeviceID = authority.Revision, actor.DeviceID
		}
		frame, err := PolicyAttestationFrame(binding.ServerID, anchor.Digest, actor, view)
		if err != nil {
			t.Fatal(err)
		}
		return ed25519.Sign(key, frame)
	}
	if err := store.CommitPolicyAttestation(ctx, resolve(genesis), verify, 1, signAttestation(genesis, genesisKey, anchor, nil)); err != nil {
		t.Fatal(err)
	}
	identityID := strings.Repeat("1", 64)
	authorize := signScopeAuthorityTestLink(t, chainBinding, ScopeAuthorityLink{Sequence: 1, Previous: anchor.Digest,
		Action: AuthorizeScopeRecovery, Revision: 2, PolicyHead: anchor.Digest, OperationID: ops(2), RecoveryID: identityID,
		RecoveryKey: scopeAuthorityTestPublicKey(recoveryKey), DeviceKey: scopeAuthorityTestPublicKey(genesisKey)}, genesisKey, nil)
	authorization := insertProof(genesis, 2, anchor.Digest, EnrollPolicyRecovery, &PolicyResourceChange{ID: ownerID,
		Recovery: &RecoveryPolicyEnrollment{RecoveryID: identityID, SigningKey: authorize.RecoveryKey, ScopeAuthority: &authorize}})
	previous, err := ScopeAuthorityLinkDigest(chainBinding, authorize)
	if err != nil {
		t.Fatal(err)
	}
	transfer := signScopeAuthorityTestLink(t, chainBinding, ScopeAuthorityLink{Sequence: 2, Previous: previous,
		Action: RecoverPolicyDevice, Revision: 3, PolicyHead: authorization.Digest, OperationID: ops(3), RecoveryID: identityID,
		RecoveryKey: authorize.RecoveryKey, DeviceKey: scopeAuthorityTestPublicKey(replacementKey)}, recoveryKey, replacementKey)
	oldDevice := state.PolicyDevices[genesis.DeviceID]
	oldDevice.Revoked = true
	state.PolicyDevices[genesis.DeviceID] = oldDevice
	delete(state.KeyRecipients, genesis.DeviceID)
	addDevice(replacement, replacementKey, 43)
	transferred := insertProof(replacement, 3, authorization.Digest, RecoverPolicyDevice, &PolicyResourceChange{ID: ownerID,
		RecoveryDevice: &RecoveryPolicyDevice{RecoveryID: identityID, SigningKey: transfer.DeviceKey, ScopeAuthority: &transfer}})
	if err := store.CommitPolicyAttestation(ctx, resolve(genesis), verify, 3, signAttestation(genesis, genesisKey, transferred, nil), binding); !errors.Is(err, MissingGrant) {
		t.Fatalf("retired signer commit = %v", err)
	}
	if err := store.CommitPolicyAttestation(ctx, resolve(replacement), verify, 3, signAttestation(replacement, replacementKey, transferred, nil), binding); !errors.Is(err, ErrPolicySignatureRequired) {
		t.Fatalf("v1 signature after transfer = %v", err)
	}
	var pending PendingPolicyAttestations
	if err := store.DispatchPendingPolicyAttestations(ctx, resolve(replacement), func(value PendingPolicyAttestations) error {
		pending = value
		return nil
	}, binding); err != nil || pending.AuthorityRevision != 3 || pending.SignerDeviceID != replacement.DeviceID ||
		pending.HeadDigest != transferred.Digest || !slices.Equal(pending.Revisions, []int64{2, 3}) {
		t.Fatalf("pending = %+v, err = %v", pending, err)
	}
	for _, target := range []PolicyProof{authorization, transferred, transferred} {
		signature := signAttestation(replacement, replacementKey, target, &transfer)
		if err := store.CommitPolicyAttestation(ctx, resolve(replacement), verify, target.Draft.Revision, signature, binding); err != nil {
			t.Fatalf("commit revision %d: %v", target.Draft.Revision, err)
		}
	}
	if err := store.CommitPolicyAttestation(ctx, resolve(replacement), verify, 1, signAttestation(replacement, replacementKey, anchor, &transfer), binding); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("overwriting historical v1 signature = %v", err)
	}
	for _, target := range []int64{0, 1, 2, 3} {
		var view PolicyAttestation
		if err := store.DispatchPolicyAttestation(ctx, resolve(reader), verify, target, func(value PolicyAttestation) error {
			view = value
			return nil
		}, binding); err != nil {
			t.Fatalf("read revision %d: %v", target, err)
		}
		if target == 1 {
			if view.SignerKey != scopeAuthorityTestPublicKey(genesisKey) || view.AuthorityRevision != 0 || view.SignerDeviceID != "" {
				t.Fatalf("legacy attestation changed: %+v", view)
			}
		} else if view.SignerKey != transfer.DeviceKey || view.AuthorityRevision != 3 || view.AuthorityHead != pending.AuthorityHead || view.SignerDeviceID != replacement.DeviceID {
			t.Fatalf("transferred attestation mismatch: %+v", view)
		}
	}
	rotatedRecovery := signScopeAuthorityTestLink(t, chainBinding, ScopeAuthorityLink{Sequence: 3, Previous: pending.AuthorityHead,
		Action: AuthorizeScopeRecovery, Revision: 4, PolicyHead: transferred.Digest, OperationID: ops(4), RecoveryID: strings.Repeat("2", 64),
		RecoveryKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(35)), DeviceKey: transfer.DeviceKey}, replacementKey, nil)
	rotated := insertProof(replacement, 4, transferred.Digest, EnrollPolicyRecovery, &PolicyResourceChange{ID: ownerID,
		Recovery: &RecoveryPolicyEnrollment{RecoveryID: rotatedRecovery.RecoveryID, SigningKey: rotatedRecovery.RecoveryKey, ScopeAuthority: &rotatedRecovery}})
	if err := store.CommitPolicyAttestation(ctx, resolve(replacement), verify, 4,
		signAttestation(replacement, replacementKey, rotated, &transfer), binding); !errors.Is(err, ErrPolicySignatureRequired) {
		t.Fatalf("retired authority head attestation = %v", err)
	}
	if err := store.CommitPolicyAttestation(ctx, resolve(replacement), verify, 4,
		signAttestation(replacement, replacementKey, rotated, &rotatedRecovery), binding); err != nil {
		t.Fatal(err)
	}
	for target, wantAuthority := range map[int64]int64{0: 4, 2: 3} {
		if err := store.DispatchPolicyAttestation(ctx, resolve(reader), verify, target, func(view PolicyAttestation) error {
			if view.AuthorityRevision != wantAuthority {
				t.Fatalf("read revision %d: authority revision = %d, want %d", target, view.AuthorityRevision, wantAuthority)
			}
			return nil
		}, binding); err != nil {
			t.Fatalf("read revision %d after rotating recovery identity: %v", target, err)
		}
	}
	// A different owner changes both identities used by the attestation frame.
	readerRecoveryKey := scopeAuthorityTestKey(36)
	readerRecovery := RecoveryIdentity{ID: strings.Repeat("3", 64), SigningKey: scopeAuthorityTestPublicKey(readerRecoveryKey),
		AgreementKey: recoveryTestAgreementKey(t, 44)}
	state.RecoveryIdentities = map[string]RecoveryIdentity{readerID: readerRecovery}
	state.RecoveryReady = map[string]bool{readerID: true}
	state.KeyRecipients[readerRecovery.ID] = KeyRecipient{ProfileID: readerID, Kind: "recovery", PublicKey: readerRecovery.AgreementKey}
	ready := insertProof(reader, 5, rotated.Digest, ConfirmPolicyRecovery, nil)
	previous, err = ScopeAuthorityLinkDigest(chainBinding, rotatedRecovery)
	if err != nil {
		t.Fatal(err)
	}
	readerDeviceKey := scopeAuthorityTestPublicKey(readerKey)
	claim, err := ScopeOwnershipCandidateClaim([]string{readerDeviceKey}, readerDeviceKey, 1000)
	if err != nil {
		t.Fatal(err)
	}
	claim.CutoverDigest = chainBinding.CutoverDigest
	ownership := signScopeOwnershipTestLink(t, chainBinding, ownerID, ScopeAuthorityLink{Sequence: 4, Previous: previous,
		Action: TransferPolicyOwnership, Revision: 6, PolicyHead: ready.Digest, OperationID: ops(6),
		TargetProfileID: readerID, RecoveryID: readerRecovery.ID, RecoveryKey: readerRecovery.SigningKey,
		DeviceKey: readerDeviceKey, Transfer: &claim}, replacementKey, readerKey)
	state.Owner = readerID
	newOwner := insertProof(replacement, 6, ready.Digest, TransferPolicyOwnership, &PolicyResourceChange{ID: readerID, OwnershipTransfer: &ownership})
	if err := VerifyOwnershipScopeAuthority(ctx, db, binding.ServerID, binding.CutoverDigest, replacement, newOwner.Draft); err != nil {
		t.Fatalf("stored compact owner transfer did not verify: %v", err)
	}
	if err := store.CommitPolicyAttestation(ctx, resolve(replacement), verify, 6, bytes.Repeat([]byte{1}, 64), binding); !errors.Is(err, MissingGrant) {
		t.Fatalf("previous owner can still attest: %v", err)
	}
	if err := store.CommitPolicyAttestation(ctx, resolve(reader), verify, 6, signAttestation(reader, readerKey, newOwner, &ownership), binding); err != nil {
		t.Fatalf("new owner cannot attest: %v", err)
	}
	if err := store.DispatchPolicyAttestation(ctx, resolve(replacement), verify, 0, func(view PolicyAttestation) error {
		if view.SignerDeviceID != reader.DeviceID || view.SignerProfileID != readerID || view.AuthorityRevision != 6 {
			t.Fatalf("view after transferring to another profile: %+v", view)
		}
		return nil
	}, binding); err != nil {
		t.Fatal(err)
	}
}
