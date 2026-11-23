package access

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestArchivePersonalDenyRecoverySourcePreviousPolicy(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "archive-recovery.sqlite")))
	now := time.Unix(1_800_000_000, 0)
	store := NewStoreWithClock(db, func() time.Time { return now })
	channel, serverID, cutover := strings.Repeat("9", 32), strings.Repeat("a", 32), strings.Repeat("b", 64)
	ownerKey := scopeAuthorityTestKey(1)
	owner := Principal{ProfileID: strings.Repeat("1", 64), DeviceID: hexHash(ownerKey.Public().(ed25519.PublicKey))}
	holderKey := scopeAuthorityTestKey(2)
	holder := Principal{ProfileID: strings.Repeat("2", 64), DeviceID: hexHash(holderKey.Public().(ed25519.PublicKey))}
	targetKey := scopeAuthorityTestKey(3)
	target := Principal{ProfileID: strings.Repeat("3", 64), DeviceID: hexHash(targetKey.Public().(ed25519.PublicKey))}
	identity := RecoveryIdentity{ID: strings.Repeat("c", 64), SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(4)),
		AgreementKey: recoveryTestAgreementKey(t, 4)}
	recipients := map[string]KeyRecipient{
		owner.DeviceID:  {ProfileID: owner.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, 1)},
		target.DeviceID: {ProfileID: target.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, 3)},
		identity.ID:     {ProfileID: holder.ProfileID, Kind: "recovery", PublicKey: identity.AgreementKey},
	}
	initial := State{RoleSnapshot: RoleSnapshot{
		Policy: Policy{Owner: owner.ProfileID, Order: []string{"historian"}, Roles: map[string]Role{
			Everyone: {Grants: []string{ChannelView}}, "historian": {Grants: []string{"history.full"}},
		}},
		Members: map[string]Subject{
			owner.ProfileID:  {ID: owner.ProfileID, Active: true},
			holder.ProfileID: {ID: holder.ProfileID, Active: true, Roles: []string{"historian"}},
			target.ProfileID: {ID: target.ProfileID, Active: true},
		}},
		Channels: map[string]Channel{channel: {Kind: "text", NextPosition: 1}},
		PolicyDevices: map[string]PolicyDevice{
			owner.DeviceID:  {ProfileID: owner.ProfileID, PublicKey: scopeAuthorityTestPublicKey(ownerKey)},
			holder.DeviceID: {ProfileID: holder.ProfileID, PublicKey: scopeAuthorityTestPublicKey(holderKey)},
			target.DeviceID: {ProfileID: target.ProfileID, PublicKey: scopeAuthorityTestPublicKey(targetKey)},
		},
		KeyRecipients: recipients, RecoveryIdentities: map[string]RecoveryIdentity{holder.ProfileID: identity},
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	verifyPolicy := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		if draft.Action == EditScopedChannelACLPersonal {
			return VerifyScopedChannelACLPersonalEdit(ctx, query, serverID, actor, draft)
		}
		return nil
	}
	commitPolicy := func(actor Principal, draft PolicyDraft, key ed25519.PrivateKey) PolicyProof {
		t.Helper()
		draft, err := store.PreviewPolicy(ctx, resolve(actor), draft)
		if err != nil {
			t.Fatal(err)
		}
		draft.Signature = ed25519.Sign(key, []byte(draft.OperationID))
		proof, err := store.CommitPolicy(ctx, resolve(actor), verifyPolicy, draft)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := commitPolicy(owner, PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32),
		TextProjectionVersion: TextGroupedArchiveRotationProjectionVersion, TextProjectionSeed: strings.Repeat("aa", 32)}, ownerKey)
	epochFrame := func(record EpochRecord) []byte {
		return []byte(record.PolicyDigest + record.PackagesDigest + record.KeyID)
	}
	verifyEpoch := func(_ context.Context, _ SessionQuery, actor Principal, record EpochRecord) error {
		key := ownerKey
		if actor == holder {
			key = holderKey
		}
		if !ed25519.Verify(key.Public().(ed25519.PublicKey), epochFrame(record), record.Signature) {
			return ErrEpochConflict
		}
		return nil
	}
	commitLive := func(actor Principal, key ed25519.PrivateKey, id string) EpochRecord {
		t.Helper()
		task, err := store.ClaimRotation(ctx, resolve(actor), channel, LiveEpoch)
		if err != nil {
			t.Fatal(err)
		}
		record := task.EpochRecord
		record.KeyID = strings.Repeat(id, 64)
		var packages []EpochPackage
		for id := range task.Recipients {
			packet := make([]byte, EpochPackageSize)
			if id == identity.ID {
				packet = make([]byte, RecoveryEpochPackageSize)
				copy(packet[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:], scopeAuthorityTestKey(6).Public().(ed25519.PublicKey))
			}
			packages = append(packages, EpochPackage{RecipientID: id, Purpose: LiveEpoch, Ciphertext: packet})
		}
		if record.PackagesDigest, err = PackagesDigest(packages); err != nil {
			t.Fatal(err)
		}
		record.Signature = ed25519.Sign(key, epochFrame(record))
		if err := store.CommitEpoch(ctx, resolve(actor), verifyEpoch, record, packages, nil); err != nil {
			t.Fatal(err)
		}
		return record
	}
	old := commitLive(owner, ownerKey, "d")
	predecessor := commitPolicy(holder, PolicyDraft{Action: EnrollRecipientKey, OperationID: strings.Repeat("2", 32),
		PublicKey: recoveryTestAgreementKey(t, 2), TextProjectionVersion: TextGroupedArchiveRotationProjectionVersion,
		TextProjectionSeed: strings.Repeat("bb", 32)}, holderKey)
	direct := commitLive(holder, holderKey, "e")
	operation := strings.Repeat("3", 32)
	frame, err := SignatureFrame("pawtalk-protected-channel-acl-personal-edit-v1", serverID, cutover, owner.ProfileID, owner.DeviceID,
		operation, strconv.FormatInt(predecessor.Draft.Revision, 10), predecessor.Digest, channel, "text", "", target.ProfileID, ChannelView, "deny")
	if err != nil {
		t.Fatal(err)
	}
	intent := PolicyDraft{Action: EditScopedChannelACLPersonal, OperationID: operation, PreviousDigest: predecessor.Digest,
		ResourceChange: &PolicyResourceChange{ID: channel, TargetProfileID: target.ProfileID, ACLPersonalEdit: &PolicyChannelACLPersonalEdit{
			CutoverDigest: cutover, Permission: ChannelView, Rule: "deny", EditorProof: base64.RawURLEncoding.EncodeToString(ed25519.Sign(ownerKey, frame)),
			ServerKey: base64.RawURLEncoding.EncodeToString(scopeAuthorityTestKey(5).Public().(ed25519.PublicKey)),
		}}}
	successor, err := store.CommitScopedChannelACLPersonalEdit(ctx, resolve(owner), intent,
		func(context.Context, SessionQuery, Principal, PolicyDraft) ([]byte, error) {
			return ed25519.Sign(ownerKey, []byte(operation)), nil
		}, verifyPolicy)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(rotationPriorityMillis * time.Millisecond)
	var task RotationTask
	cache := &TextChannelPolicyProofCache{}
	if err := store.DispatchRecoveryRotationTask(ctx, resolve(holder), channel, ArchiveEpoch, cache,
		func(value RotationTask) error { task = value; return nil }); err != nil {
		t.Fatal(err)
	}
	read := func(actor Principal, record EpochRecord, scope *TextChannelPolicyProofCache) ([]EpochPackageDelivery, error) {
		var deliveries []EpochPackageDelivery
		err := store.DispatchRotationRecoveryTargetPackages(ctx, resolve(actor), record, task.ArchiveTargets, verifyEpoch, scope,
			func(values []EpochPackageDelivery) error { deliveries = values; return nil })
		return deliveries, err
	}
	unattested, err := read(holder, task.EpochRecord, cache)
	if err != nil || len(unattested) != 2 || unattested[0].PreviousRecoveryPolicy != nil {
		t.Fatalf("unexpected recovery evidence before attestation: %v", err)
	}
	attestation, _, err := readAttestation(ctx, db, predecessor.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	frame, err = PolicyAttestationFrame(serverID, anchor.Digest, owner, attestation)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CommitPolicyAttestation(ctx, resolve(owner), func(_ context.Context, _ SessionQuery, signer Principal, pinned string,
		view PolicyAttestation) error {
		frame, err := PolicyAttestationFrame(serverID, pinned, signer, view)
		if err != nil || !ed25519.Verify(ownerKey.Public().(ed25519.PublicKey), frame, view.Signature) {
			return ErrPolicySignatureRequired
		}
		return nil
	}, predecessor.Draft.Revision, ed25519.Sign(ownerKey, frame)); err != nil {
		t.Fatal(err)
	}
	deliveries, err := read(holder, task.EpochRecord, cache)
	if err != nil || len(deliveries) != 2 {
		t.Fatalf("scoped recovery delivery: %v", err)
	}
	recovered := deliveries[0]
	previous := recovered.PreviousRecoveryPolicy
	if recovered.Package.RecipientID != identity.ID || recovered.Epoch.Record.KeyID != old.KeyID ||
		previous == nil || previous.Revision != predecessor.Draft.Revision || previous.PolicyDigest != predecessor.Draft.ResultDigest ||
		previous.Recipient == nil || !previous.Recipient.Statement.Archive ||
		previous.Recipient.Statement.RecipientID != identity.ID || previous.Recipient.Statement.ProfileID != holder.ProfileID ||
		previous.Recipient.Statement.PublicKey != identity.AgreementKey || previous.Recipient.Statement.Kind != "recovery" ||
		recovered.TextPolicy == nil || recovered.TextPolicy.Revision != successor.Draft.Revision ||
		deliveries[1].Epoch.Record.KeyID != direct.KeyID || deliveries[1].Package.RecipientID != holder.DeviceID ||
		deliveries[1].PreviousRecoveryPolicy != nil {
		t.Fatalf("wrong mixed recovery target evidence: %+v %+v", recovered, deliveries[1])
	}
	raw, err := json.Marshal(previous)
	if err != nil || strings.Contains(string(raw), target.DeviceID) || strings.Contains(string(raw), holder.DeviceID) {
		t.Fatalf("recovery evidence disclosed other recipients: %s %v", raw, err)
	}
	if unscoped, err := read(holder, task.EpochRecord, nil); err != nil || len(unscoped) != 2 || unscoped[0].PreviousRecoveryPolicy != nil {
		t.Fatalf("unscoped recovery evidence: %v", err)
	}
	if _, err := read(target, task.EpochRecord, cache); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("removed target obtained recovery evidence: %v", err)
	}
	stale := task.EpochRecord
	stale.Revision--
	if _, err := read(holder, stale, cache); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("stale lease obtained recovery evidence: %v", err)
	}
	previousState, oldHead, err := readPrecedingPolicyState(ctx, db, successor.Draft)
	if err != nil {
		t.Fatal(err)
	}
	currentState, _, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	laterIdentity := RecoveryIdentity{ID: strings.Repeat("f", 64), SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(7)),
		AgreementKey: recoveryTestAgreementKey(t, 7)}
	updated := currentState
	updated.RecoveryIdentities = maps.Clone(currentState.RecoveryIdentities)
	updated.RecoveryIdentities[holder.ProfileID] = laterIdentity
	updated.KeyRecipients = maps.Clone(currentState.KeyRecipients)
	updated.KeyRecipients[laterIdentity.ID] = KeyRecipient{ProfileID: holder.ProfileID, Kind: "recovery", PublicKey: laterIdentity.AgreementKey}
	if proof, err := previousArchiveRecoveryDisclosure(previousState, updated, oldHead, channel, holder.ProfileID, laterIdentity, &cache.history); err != nil || proof != nil {
		t.Fatalf("subsequent recovery identity inherited preceding proof: %+v %v", proof, err)
	}
	limited := previousState
	limited.Members = maps.Clone(previousState.Members)
	member := limited.Members[holder.ProfileID]
	member.Roles = nil
	limited.Members[holder.ProfileID] = member
	if proof, err := previousArchiveRecoveryDisclosure(limited, currentState, oldHead, channel, holder.ProfileID, identity, &cache.history); err != nil || proof != nil {
		t.Fatalf("previous live-only holder got archive recovery proof: %+v %v", proof, err)
	}
}
