package access

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestLiveRoleViewDenyTransitionDigestVector(t *testing.T) {
	record := EpochRecord{Purpose: LiveEpoch, ChannelID: strings.Repeat("4", 32), Revision: 8, PolicyDigest: strings.Repeat("c", 64)}
	evidence := RoleViewDenyEvidence{PreviousRevision: 7, PreviousHead: strings.Repeat("a", 64), SuccessorHead: strings.Repeat("b", 64),
		OperationID: strings.Repeat("1", 32), Actor: Principal{ProfileID: strings.Repeat("d", 64), DeviceID: strings.Repeat("e", 64)},
		Effect:      RoleViewDenyEffectProof{RoleID: "quarantine", PreviousRulesDigest: strings.Repeat("3", 64), NextRulesDigest: strings.Repeat("2", 64)},
		EditorProof: strings.Repeat("a", 86)}
	digest, err := liveRoleViewDenyTransitionDigest(record, evidence)
	if err != nil || digest != "91a86c3300f2f56d0cee69cc551070c613363b2a38360cf6e17607c6b70476cb" {
		t.Fatalf("live role transition marker = %q, %v", digest, err)
	}
	record.Purpose = ArchiveEpoch
	if _, err := liveRoleViewDenyTransitionDigest(record, evidence); !errors.Is(err, InvalidAction) {
		t.Fatalf("archive accepted the live role transition domain: %v", err)
	}
	digest, err = roleViewDenyTransitionDigest(record, evidence)
	if err != nil || digest != "94cd7554b404d3300628e262a2fa1fca2b379ca7bf9ec17354855dfd12cb7ffd" {
		t.Fatalf("archive role transition marker = %q, %v", digest, err)
	}
}

func TestScopedRoleViewDenyRotationEvidence(t *testing.T) {
	t.Run("archive target", func(t *testing.T) { testScopedRoleViewDenyRotationEvidence(t, true) })
	t.Run("unchanged archive", func(t *testing.T) { testScopedRoleViewDenyRotationEvidence(t, false) })
}

func testScopedRoleViewDenyRotationEvidence(t *testing.T, archiveTarget bool) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "role-view-deny.sqlite")))
	now := time.Unix(1_800_000_000, 0)
	store := NewStoreWithClock(db, func() time.Time { return now })
	serverID, cutover := strings.Repeat("a", 32), strings.Repeat("b", 64)
	channel := strings.Repeat("c", 32)
	owner, editor, viewer := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64)
	firstTarget, secondTarget, excepted := strings.Repeat("4", 64), strings.Repeat("5", 64), strings.Repeat("6", 64)
	withoutDevice, late := strings.Repeat("7", 64), strings.Repeat("9", 64)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner, Order: []string{"quarantine", "historian", "editor"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView}}, "quarantine": {}, "editor": {Grants: []string{channelACLPermission, "message.send"}},
				"historian": {Grants: []string{"history.full"}},
			}},
			Members: map[string]Subject{
				owner: {ID: owner, Active: true}, editor: {ID: editor, Active: true, Roles: []string{"editor"}}, viewer: {ID: viewer, Active: true, Roles: []string{"historian"}},
				firstTarget:   {ID: firstTarget, Active: true, Roles: []string{"quarantine"}},
				secondTarget:  {ID: secondTarget, Active: true, Roles: []string{"quarantine"}},
				excepted:      {ID: excepted, Active: true, Roles: []string{"quarantine"}},
				withoutDevice: {ID: withoutDevice, Active: true, Roles: []string{"quarantine"}},
				late:          {ID: late, Active: true},
			},
		},
		Channels: map[string]Channel{channel: {Kind: "text", NextPosition: 1,
			ACL: ACL{Profiles: map[string]Overwrite{excepted: {Allow: []string{ChannelView}}, late: {Deny: []string{ChannelView}}}}}},
		PolicyDevices: make(map[string]PolicyDevice), KeyRecipients: make(map[string]KeyRecipient),
	}
	actors := make(map[string]Principal)
	for i, profile := range []string{owner, editor, viewer, firstTarget, secondTarget, excepted, late} {
		seed := byte(i + 1)
		key := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(seed))
		device := hexHash(parseScopeAuthorityKey(key))
		actors[profile] = Principal{ProfileID: profile, DeviceID: device}
		state.PolicyDevices[device] = PolicyDevice{ProfileID: profile, PublicKey: key}
		state.KeyRecipients[device] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: recoveryTestAgreementKey(t, seed)}
	}
	if archiveTarget {
		state.Members[firstTarget] = Subject{ID: firstTarget, Active: true, Roles: []string{"quarantine", "historian"}}
	}
	recovery := RecoveryIdentity{ID: strings.Repeat("8", 64), SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(8)),
		AgreementKey: recoveryTestAgreementKey(t, 8)}
	state.RecoveryIdentities = map[string]RecoveryIdentity{viewer: recovery}
	state.KeyRecipients[recovery.ID] = KeyRecipient{ProfileID: viewer, Kind: "recovery", PublicKey: recovery.AgreementKey}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	resolve := func(profile string) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actors[profile], nil }
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		if draft.Action == EditScopedChannelACLRoleRules {
			return VerifyScopedChannelACLRoleRulesEdit(ctx, query, serverID, actor, draft)
		}
		return nil
	}
	draft, err := store.PreviewPolicy(ctx, resolve(owner), PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32),
		TextProjectionVersion: TextRoleViewDenyProjectionVersion, TextProjectionSeed: strings.Repeat("ee", 32)})
	if err != nil {
		t.Fatal(err)
	}
	draft.Signature = make([]byte, 64)
	anchor, err := store.CommitPolicy(ctx, resolve(owner), verify, draft)
	if err != nil {
		t.Fatal(err)
	}
	var cache TextChannelPolicyProofCache
	claim := func(profile, purpose string, scope *TextChannelPolicyProofCache) (RotationTask, error) {
		var result RotationTask
		err := store.DispatchRotationTask(ctx, resolve(profile), channel, purpose, scope, func(task RotationTask) error { result = task; return nil })
		return result, err
	}
	initial, err := claim(owner, LiveEpoch, &cache)
	if err != nil || initial.RoleViewDeny != nil {
		t.Fatalf("initial task role witness: %+v %v", initial.RoleViewDeny, err)
	}
	packages := roleViewDenyTestPackages(initial, recovery.ID)
	record := initial.EpochRecord
	record.KeyID, record.Signature = strings.Repeat("d", 64), make([]byte, 64)
	record.PackagesDigest, err = PackagesDigest(packages)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CommitEpoch(ctx, resolve(owner), func(context.Context, SessionQuery, Principal, EpochRecord) error { return nil }, record, packages, nil); err != nil {
		t.Fatal(err)
	}
	original := MessageAttempt{ChannelID: channel, OperationID: strings.Repeat("4", 32), KeyID: record.KeyID,
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64)}
	sent, err := store.AppendMessage(ctx, resolve(editor), func(context.Context, SessionQuery, Principal, int64, MessageAttempt) error { return nil }, original, false)
	if err != nil || sent.Position != 1 {
		t.Fatalf("write before role removal: %+v %v", sent, err)
	}
	beforeDigest, err := channelACLRoleRulesDigest(scopedACLRoleRules(state.scope(state.Channels[channel])))
	if err != nil {
		t.Fatal(err)
	}
	rules := map[string]Overwrite{"quarantine": {Deny: []string{ChannelView}}}
	afterDigest, err := channelACLRoleRulesDigest(rules)
	if err != nil {
		t.Fatal(err)
	}
	operation := strings.Repeat("2", 32)
	frame, err := SignatureFrame("pawtalk-protected-channel-acl-roles-edit-v1", serverID, cutover, editor, actors[editor].DeviceID,
		operation, "1", anchor.Digest, channel, "text", "", beforeDigest, afterDigest)
	if err != nil {
		t.Fatal(err)
	}
	editorProof := base64.RawURLEncoding.EncodeToString(ed25519.Sign(scopeAuthorityTestKey(2), frame))
	intent := PolicyDraft{Action: EditScopedChannelACLRoleRules, OperationID: operation, PreviousDigest: anchor.Digest,
		ResourceChange: &PolicyResourceChange{ID: channel, ACL: &ACL{Roles: rules}, ACLRoleEdit: &PolicyChannelACLRoleEdit{
			PreviousRulesDigest: beforeDigest, CutoverDigest: cutover, EditorProof: editorProof,
			ServerKey: base64.RawURLEncoding.EncodeToString(scopeAuthorityTestKey(7).Public().(ed25519.PublicKey)),
		}}}
	changed, err := store.CommitScopedChannelACLRoleRulesEdit(ctx, resolve(editor), intent,
		func(context.Context, SessionQuery, Principal, PolicyDraft) ([]byte, error) {
			signature := make([]byte, 64)
			signature[0] = 1
			return signature, nil
		}, verify)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(rotationPriorityMillis * time.Millisecond)
	if promised, err := claim(viewer, LiveEpoch, &cache); err != nil || promised.RoleViewDeny != nil {
		t.Fatalf("witness without prior owner attestation: %+v %v", promised.RoleViewDeny, err)
	}
	ownerKey := scopeAuthorityTestKey(1)
	publish := func(revision int64) {
		t.Helper()
		attestation, _, err := readAttestation(ctx, db, revision)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := PolicyAttestationFrame(serverID, anchor.Digest, actors[owner], attestation)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.CommitPolicyAttestation(ctx, resolve(owner), func(_ context.Context, _ SessionQuery, signer Principal,
			pinned string, attestation PolicyAttestation) error {
			signed, err := PolicyAttestationFrame(serverID, pinned, signer, attestation)
			if err != nil || signer != actors[owner] || !ed25519.Verify(ownerKey.Public().(ed25519.PublicKey), signed, attestation.Signature) {
				return ErrPolicyConflict
			}
			return nil
		}, revision, ed25519.Sign(ownerKey, frame)); err != nil {
			t.Fatal(err)
		}
	}
	publish(anchor.Draft.Revision)
	task, err := claim(viewer, LiveEpoch, &cache)
	proof := task.RoleViewDeny
	if err != nil || proof == nil {
		t.Fatalf("missing scoped role deny evidence: %v", err)
	}
	if proof.PreviousRevision != anchor.Draft.Revision || proof.PreviousHead != anchor.Digest || proof.SuccessorHead != changed.Digest ||
		proof.Actor != actors[editor] || proof.EditorProof != editorProof || proof.OperationID != operation ||
		proof.PreviousTextPolicy.Recipient.Statement.RecipientID != actors[viewer].DeviceID ||
		proof.Effect.RoleID != "quarantine" || proof.Effect.PreviousRulesDigest != beforeDigest || proof.Effect.NextRulesDigest != afterDigest ||
		!slices.Equal(proof.Effect.ExcludedProfiles, []string{firstTarget, secondTarget, withoutDevice}) || len(task.Recipients) != 5 ||
		task.Recipients[actors[excepted].DeviceID].ProfileID != excepted {
		t.Fatalf("role deny did not authenticate the exact visibility change: %+v", proof)
	}
	if len(proof.SurvivorOpenings) != 4 || len(proof.RemovedGroups) != 2 || proof.RemovedGroups[withoutDevice].Digest != "" {
		t.Fatalf("role deny incorrectly opened keyless or unrelated groups: %+v", proof.RemovedGroups)
	}
	var priorSeed [32]byte
	for i := range priorSeed {
		priorSeed[i] = 0xee
	}
	for _, target := range []string{firstTarget, secondTarget} {
		opening := textRotationProfileOpening(priorSeed, channel, LiveEpoch, target)
		oldDevice := actors[target].DeviceID
		commitment, err := textRotationDigest(map[string]KeyRecipient{oldDevice: initial.Recipients[oldDevice]}, opening.ContentSalt)
		if err != nil || proof.RemovedGroups[target] != (LivePersonalDenyRemovedGroup{Salt: opening.Salt, Digest: commitment}) {
			t.Fatalf("wrong prior group digest for %s: %v", target, err)
		}
	}
	raw, err := json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	for _, hidden := range []string{actors[firstTarget].DeviceID, actors[secondTarget].DeviceID, `"rules":`, `"rulesSalt":`,
		textRotationProfileOpening(priorSeed, channel, LiveEpoch, firstTarget).ContentSalt,
		textRotationProfileOpening(priorSeed, channel, LiveEpoch, secondTarget).ContentSalt} {
		if strings.Contains(string(raw), hidden) {
			t.Fatalf("role deny evidence disclosed removed key or ACL material: %s", hidden)
		}
	}
	if plain, err := claim(viewer, LiveEpoch, nil); err != nil || plain.RoleViewDeny != nil {
		t.Fatalf("unscoped task disclosed role effect: %+v %v", plain.RoleViewDeny, err)
	}
	if denied, err := claim(firstTarget, LiveEpoch, &cache); !errors.Is(err, ChannelRestricted) || denied.RoleViewDeny != nil {
		t.Fatalf("excluded member obtained live witness: %+v %v", denied.RoleViewDeny, err)
	}
	if archive, err := claim(excepted, ArchiveEpoch, &cache); !errors.Is(err, ErrRotationUnavailable) || archive.RoleViewDeny != nil {
		t.Fatalf("limited member obtained archive role effect: %+v %v", archive.RoleViewDeny, err)
	}
	current, _, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	wrongAudience := task
	wrongAudience.Recipients = maps.Clone(task.Recipients)
	delete(wrongAudience.Recipients, actors[excepted].DeviceID)
	if forged, err := roleViewDenyRotationEvidence(ctx, db, current, changed, wrongAudience, actors[viewer], &cache.history); err != nil || forged != nil {
		t.Fatalf("wrong surviving audience received an effect witness: %+v %v", forged, err)
	}
	var firstArchiveTask RotationTask
	if archiveTarget {
		firstArchiveTask, err = claim(viewer, ArchiveEpoch, &cache)
		if err != nil || firstArchiveTask.RoleViewDeny == nil || firstArchiveTask.ArchiveThrough != record.Generation {
			t.Fatalf("did not get partial archive lease: %v", err)
		}
	}
	live, verifyEpoch := assertCommittedRoleViewDeny(t, ctx, store, resolve, task, proof, actors, viewer, editor, excepted, firstTarget, recovery.ID, &cache)
	var firstArchive EpochRecord
	if archiveTarget {
		firstArchive = commitRoleViewDenyArchive(t, ctx, store, resolve(viewer), firstArchiveTask, live, recovery.ID, strings.Repeat("a", 64), 10)
	}
	archive, err := claim(viewer, ArchiveEpoch, &cache)
	if err != nil || archive.RoleViewDeny == nil || archive.ArchivePersonalDeny != nil || archive.ArchiveThrough != live.Generation {
		t.Fatalf("archive role task before owner attestation: %v", err)
	}
	current, _, err = store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	oldRecovery, err := archiveRotationPreviousRecoveryPolicy(ctx, db, current, changed, archive.EpochRecord, actors[viewer], recovery, &cache.history)
	if err != nil || oldRecovery == nil || oldRecovery.Revision != anchor.Draft.Revision || oldRecovery.Recipient == nil ||
		oldRecovery.Recipient.Statement.RecipientID != recovery.ID || !oldRecovery.Recipient.Statement.Archive {
		t.Fatalf("missing previous recovery opening for exact archive role task: %+v %v", oldRecovery, err)
	}
	if disclosure, err := archiveRotationPreviousRecoveryPolicy(ctx, db, current, changed, archive.EpochRecord, actors[owner], recovery, &cache.history); err != nil || disclosure != nil {
		t.Fatalf("wrong profile received previous recovery opening: %+v %v", disclosure, err)
	}
	storedArchive := assertRoleViewDenyArchiveCommit(t, ctx, store, resolve, archive, live, firstArchive, actors, viewer, owner, excepted, firstTarget,
		recovery.ID, archiveTarget, verifyEpoch, &cache)
	testRoleDenyStoredRevision(t, ctx, store, resolve, actors, owner, editor, viewer, excepted, firstTarget, secondTarget, withoutDevice, late,
		sent.Position, storedArchive, archive.RoleViewDeny, archiveTarget, publish, verify, verifyEpoch, &cache)
}

func roleViewDenyTestPackages(task RotationTask, recoveryID string) []EpochPackage {
	var packages []EpochPackage
	for id := range task.Recipients {
		ciphertext := make([]byte, EpochPackageSize)
		if id == recoveryID {
			ciphertext = make([]byte, RecoveryEpochPackageSize)
			copy(ciphertext[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:], scopeAuthorityTestKey(9).Public().(ed25519.PublicKey))
		}
		packages = append(packages, EpochPackage{RecipientID: id, Purpose: task.Purpose, Ciphertext: ciphertext})
	}
	return packages
}

func assertRoleViewDenyArchiveCommit(t *testing.T, ctx context.Context, store *Store, resolve func(string) ResolveSession,
	task RotationTask, live, firstArchive EpochRecord, actors map[string]Principal, viewer, reader, limited, denied, recoveryID string,
	archiveTarget bool, verify VerifyEpochRecord, cache *TextChannelPolicyProofCache) EpochRecord {
	t.Helper()
	proof := task.RoleViewDeny
	removed := proof.RemovedGroups[denied]
	wantRemoved := 0
	if archiveTarget {
		wantRemoved = 1
	}
	if len(proof.RemovedGroups) != wantRemoved || isDigest(removed.Digest) != archiveTarget ||
		len(proof.SurvivorOpenings) != 2 || len(task.Recipients) != 3 ||
		!proof.PreviousTextPolicy.Recipient.Statement.Archive {
		t.Fatalf("archive did not use exact previous archive groups: %+v", proof.RemovedGroups)
	}
	if archiveTarget {
		var seed [32]byte
		for i := range seed {
			seed[i] = 0xee
		}
		archiveOpening := textRotationProfileOpening(seed, task.ChannelID, ArchiveEpoch, denied)
		liveOpening := textRotationProfileOpening(seed, task.ChannelID, LiveEpoch, denied)
		if removed.Salt != archiveOpening.Salt || removed.Salt == liveOpening.Salt {
			t.Fatal("removed archive group used a live-domain salt")
		}
	}
	assertScopedRoleViewDenyArchiveSources(t, ctx, store, resolve(viewer), resolve(limited), task, live, actors[viewer], verify, cache, actors[denied].DeviceID)
	archive := commitRoleViewDenyArchive(t, ctx, store, resolve(viewer), task, live, recoveryID, strings.Repeat("9", 64), 11)
	assertScopedRoleViewDenyArchiveDeliveries(t, ctx, store, resolve(reader), resolve(limited), resolve(denied), archive,
		actors[reader], actors[viewer], proof, verify, cache, actors[denied].DeviceID)
	if firstArchive.Generation != 0 {
		if firstArchive.ArchiveTransitionDigest != archive.ArchiveTransitionDigest || archive.PreviousDigest != hexHash(firstArchive.Signature) {
			t.Fatal("two archive commits did not form the same role transition chain")
		}
		if err := store.DispatchEpochProofPage(ctx, resolve(reader), archive.ChannelID, ArchiveEpoch, 0, archive.Generation, verify, cache,
			func(page []EpochProof) error {
				if len(page) != 2 || page[0].Record.KeyID != firstArchive.KeyID || page[0].ArchiveRoleViewDeny != page[1].ArchiveRoleViewDeny {
					t.Fatalf("older role archive proof was omitted or rebuilt: %+v", page)
				}
				assertCompactRoleViewDenyReadEvidence(t, page[0].ArchiveRoleViewDeny, proof, actors[reader], actors[viewer], ArchiveEpoch, actors[denied].DeviceID)
				return nil
			}); err != nil {
			t.Fatal(err)
		}
		if err := store.DispatchArchiveLinks(ctx, resolve(reader), archive.ChannelID, firstArchive.KeyID, verify, cache,
			func(delivery ArchiveLinkDelivery) error {
				assertCompactRoleViewDenyReadEvidence(t, delivery.Epoch.ArchiveRoleViewDeny, proof, actors[reader], actors[viewer], ArchiveEpoch, actors[denied].DeviceID)
				return nil
			}); err != nil {
			t.Fatal(err)
		}
	}
	return archive
}

func commitRoleViewDenyArchive(t *testing.T, ctx context.Context, store *Store, resolve ResolveSession, task RotationTask,
	live EpochRecord, recoveryID, keyID string, wrapSeed byte) EpochRecord {
	t.Helper()
	record := task.EpochRecord
	record.KeyID = keyID
	record.ArchiveWrapKey = recoveryTestAgreementKey(t, wrapSeed)
	packages := roleViewDenyTestPackages(task, recoveryID)
	var links []ArchiveLink
	for _, target := range task.ArchiveTargets {
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
	record.ArchiveTransitionDigest, err = roleViewDenyTransitionDigest(record, task.RoleViewDeny.RoleViewDenyEvidence)
	if err != nil {
		t.Fatal(err)
	}
	key := scopeAuthorityTestKey(3)
	verify := func(_ context.Context, _ SessionQuery, _ Principal, candidate EpochRecord) error {
		if !ed25519.Verify(key.Public().(ed25519.PublicKey), personalDenyBatchEpochFrame(candidate), candidate.Signature) {
			return ErrEpochConflict
		}
		return nil
	}
	wrong := record
	wrong.ArchiveTransitionDigest = live.LiveTransitionDigest
	wrong.Signature = ed25519.Sign(key, personalDenyBatchEpochFrame(wrong))
	if err := store.CommitEpoch(ctx, resolve, verify, wrong, packages, links); !errors.Is(err, ErrEpochConflict) {
		t.Fatalf("archive accepted the live role marker: %v", err)
	}
	record.Signature = ed25519.Sign(key, personalDenyBatchEpochFrame(record))
	if err := store.CommitEpoch(ctx, resolve, verify, record, packages, links); err != nil {
		t.Fatal(err)
	}
	return record
}

func assertCommittedRoleViewDeny(t *testing.T, ctx context.Context, store *Store, resolve func(string) ResolveSession,
	task RotationTask, proof *RoleViewDenyRotationEvidence, actors map[string]Principal, viewer, editor, reader, denied string,
	recoveryID string, cache *TextChannelPolicyProofCache) (EpochRecord, VerifyEpochRecord) {
	t.Helper()
	packages := roleViewDenyTestPackages(task, recoveryID)
	record := task.EpochRecord
	record.KeyID = strings.Repeat("f", 64)
	var err error
	record.PackagesDigest, err = PackagesDigest(packages)
	if err != nil {
		t.Fatal(err)
	}
	record.LiveTransitionDigest, err = liveRoleViewDenyTransitionDigest(record, proof.RoleViewDenyEvidence)
	if err != nil {
		t.Fatal(err)
	}
	key := scopeAuthorityTestKey(3)
	verify := func(_ context.Context, _ SessionQuery, signer Principal, candidate EpochRecord) error {
		if candidate.Revision < task.Revision {
			return nil
		}
		if signer != actors[viewer] || !ed25519.Verify(key.Public().(ed25519.PublicKey), personalDenyBatchEpochFrame(candidate), candidate.Signature) {
			return ErrEpochConflict
		}
		return nil
	}
	commit := func(candidate EpochRecord) error {
		candidate.Signature = ed25519.Sign(key, personalDenyBatchEpochFrame(candidate))
		return store.CommitEpoch(ctx, resolve(viewer), verify, candidate, packages, nil)
	}
	wrong := record
	wrong.LiveTransitionDigest, err = livePersonalDenyTransitionDigest(record, PersonalDenyRotationEvidence{
		PreviousRevision: proof.PreviousRevision, PreviousHead: proof.PreviousHead, SuccessorHead: proof.SuccessorHead,
		OperationID: proof.OperationID, Actor: proof.Actor, EditorProof: proof.EditorProof, TargetProfileID: denied,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := commit(wrong); !errors.Is(err, ErrEpochConflict) {
		t.Fatalf("signed role transition accepted the personal deny domain: %v", err)
	}
	if err := commit(record); err != nil {
		t.Fatal(err)
	}
	load := func(profile string, scoped bool) (EpochPackageDelivery, error) {
		var delivery EpochPackageDelivery
		err := store.DispatchCurrentEpochPackage(ctx, resolve(profile), record.ChannelID, LiveEpoch, verify, cache, scoped, nil,
			func(value EpochPackageDelivery) error { delivery = value; return nil })
		return delivery, err
	}
	delivery, err := load(reader, true)
	read := delivery.LiveRoleViewDeny
	if err != nil || read == nil || delivery.LivePersonalDeny != nil || delivery.ArchivePersonalDeny != nil ||
		delivery.Package.RecipientID != actors[reader].DeviceID || delivery.Epoch.Record.LiveTransitionDigest != record.LiveTransitionDigest ||
		read.PreviousTextPolicy.Recipient.Statement.RecipientID != actors[reader].DeviceID ||
		read.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != actors[viewer].DeviceID {
		t.Fatalf("addressed live role transition: %+v %v", read, err)
	}
	encoded, err := json.Marshal(read)
	if err != nil {
		t.Fatal(err)
	}
	for _, hidden := range []string{actors[denied].DeviceID, `"removedGroups":`, `"survivorOpenings":`, `"rules":`} {
		if strings.Contains(string(encoded), hidden) {
			t.Fatalf("addressed role read witness disclosed %s", hidden)
		}
	}
	if plain, err := load(reader, false); err != nil || plain.LiveRoleViewDeny != nil {
		t.Fatalf("unscoped read returned a role transition: %v", err)
	}
	if blocked, err := load(denied, true); !errors.Is(err, ChannelRestricted) || blocked.LiveRoleViewDeny != nil {
		t.Fatalf("removed viewer obtained a role transition: %v", err)
	}
	attempt := MessageAttempt{ChannelID: record.ChannelID, OperationID: strings.Repeat("3", 32), KeyID: record.KeyID,
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64)}
	if _, err := store.AppendMessage(ctx, resolve(editor), func(context.Context, SessionQuery, Principal, int64, MessageAttempt) error { return nil }, attempt, false); err != nil {
		t.Fatal(err)
	}
	if err := store.DispatchLiveMessages(ctx, resolve(reader), record.ChannelID, 1, 2, cache, false,
		func(page LiveMessagePage) error {
			if len(page.Messages) != 1 || page.Messages[0].PreviousAuthorPolicy == nil ||
				page.Messages[0].PreviousAuthorPolicy.Recipient.Statement.RecipientID != actors[editor].DeviceID ||
				!*page.Messages[0].PreviousAuthorPolicy.Recipient.Statement.CanSend {
				t.Fatalf("role-stamped live message lost its preceding author proof: %+v", page.Messages)
			}
			return nil
		}, verify); err != nil {
		t.Fatal(err)
	}
	return delivery.Epoch.Record, verify
}
