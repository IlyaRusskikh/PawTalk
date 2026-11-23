package access

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLivePersonalDenyEvidenceOnlyOpensSurvivors(t *testing.T) {
	t.Run("v13 archive target", func(t *testing.T) {
		testPersonalDenyRotationEvidence(t, TextGroupedRotationProjectionVersion, true, false)
	})
	t.Run("v14 archive target", func(t *testing.T) {
		testPersonalDenyRotationEvidence(t, TextGroupedArchiveRotationProjectionVersion, true, false)
	})
	t.Run("v14 limited target", func(t *testing.T) {
		testPersonalDenyRotationEvidence(t, TextGroupedArchiveRotationProjectionVersion, false, false)
	})
	t.Run("v14 two signed archive batches", func(t *testing.T) {
		testPersonalDenyRotationEvidence(t, TextGroupedArchiveRotationProjectionVersion, true, true)
	})
	t.Run("v15 stored revision after full-history target deny", func(t *testing.T) {
		testPersonalDenyRotationEvidence(t, TextGroupedRevisionAudienceProjectionVersion, true, false)
	})
	t.Run("v15 stored revision after limited target deny", func(t *testing.T) {
		testPersonalDenyRotationEvidence(t, TextGroupedRevisionAudienceProjectionVersion, false, false)
	})
}

func testPersonalDenyRotationEvidence(t *testing.T, version int, archiveTarget, multiBatch bool) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "live-deny.sqlite")))
	now := time.Unix(1_800_000_000, 0)
	store := NewStoreWithClock(db, func() time.Time { return now })
	serverID, cutover := strings.Repeat("a", 32), strings.Repeat("b", 64)
	channel, category := strings.Repeat("9", 32), strings.Repeat("8", 32)
	owner, editor, target, claimant := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64)
	viewer := strings.Repeat("5", 64)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner, Order: []string{"historian", "editor"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView}}, "editor": {Grants: []string{channelACLPermission, "message.send"}},
				"historian": {Grants: []string{"history.full"}},
			}},
			Members: map[string]Subject{
				owner: {ID: owner, Active: true}, editor: {ID: editor, Active: true, Roles: []string{"editor"}},
				target: {ID: target, Active: true}, claimant: {ID: claimant, Active: true, Roles: []string{"historian"}},
				viewer: {ID: viewer, Active: true},
			},
		},
		Channels: map[string]Channel{channel: {Kind: "text", CategoryID: category, Synchronized: true, NextPosition: 1}},
		Categories: map[string]ACL{category: {
			Roles: map[string]Overwrite{"editor": {Deny: []string{"message.pin"}}},
		}},
		PolicyDevices: make(map[string]PolicyDevice),
		KeyRecipients: make(map[string]KeyRecipient),
	}
	if archiveTarget {
		state.Members[target] = Subject{ID: target, Active: true, Roles: []string{"historian"}}
	}
	actors := make(map[string]Principal)
	for i, profile := range []string{owner, editor, target, claimant, viewer} {
		seed := byte(i + 1)
		key := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(seed))
		device := hexHash(parseScopeAuthorityKey(key))
		actors[profile] = Principal{ProfileID: profile, DeviceID: device}
		state.PolicyDevices[device] = PolicyDevice{ProfileID: profile, PublicKey: key}
		state.KeyRecipients[device] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: recoveryTestAgreementKey(t, seed)}
	}
	recovery := RecoveryIdentity{ID: strings.Repeat("e", 64), SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(8)),
		AgreementKey: recoveryTestAgreementKey(t, 8)}
	state.RecoveryIdentities = map[string]RecoveryIdentity{target: recovery}
	state.KeyRecipients[recovery.ID] = KeyRecipient{ProfileID: target, Kind: "recovery", PublicKey: recovery.AgreementKey}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	resolve := func(profile string) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actors[profile], nil }
	}
	appendMessage := func(key, operation string, nonce byte) {
		t.Helper()
		attempt := MessageAttempt{ChannelID: channel, OperationID: operation, KeyID: key,
			Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64)}
		attempt.Nonce[0] = nonce
		verify := func(context.Context, SessionQuery, Principal, int64, MessageAttempt) error { return nil }
		if _, err := store.AppendMessage(ctx, resolve(editor), verify, attempt, false); err != nil {
			t.Fatal(err)
		}
	}
	verifyPolicy := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		if draft.Action == EditScopedChannelACLPersonal {
			return VerifyScopedChannelACLPersonalEdit(ctx, query, serverID, actor, draft)
		}
		return nil
	}
	draft, err := store.PreviewPolicy(ctx, resolve(owner), PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32),
		TextProjectionVersion: version, TextProjectionSeed: strings.Repeat("aa", 32)})
	if err != nil {
		t.Fatal(err)
	}
	draft.Signature = make([]byte, 64)
	anchor, err := store.CommitPolicy(ctx, resolve(owner), verifyPolicy, draft)
	if err != nil {
		t.Fatal(err)
	}
	var cache TextChannelPolicyProofCache
	claimPurpose := func(profile, purpose string, scope *TextChannelPolicyProofCache) RotationTask {
		t.Helper()
		var task RotationTask
		if err := store.DispatchRotationTask(ctx, resolve(profile), channel, purpose, scope, func(value RotationTask) error {
			task = value
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return task
	}
	claim := func(profile string, scope *TextChannelPolicyProofCache) RotationTask {
		return claimPurpose(profile, LiveEpoch, scope)
	}
	before := claim(owner, &cache)
	if before.LivePersonalDeny != nil || len(before.Recipients) != 6 {
		t.Fatalf("unexpected precursor claim: %+v", before)
	}
	record := before.EpochRecord
	record.KeyID, record.Signature = strings.Repeat("d", 64), make([]byte, 64)
	var packages []EpochPackage
	for id := range before.Recipients {
		epochPackage := EpochPackage{RecipientID: id, Purpose: LiveEpoch, Ciphertext: make([]byte, EpochPackageSize)}
		if id == recovery.ID {
			epochPackage.Ciphertext = make([]byte, RecoveryEpochPackageSize)
			copy(epochPackage.Ciphertext[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:], scopeAuthorityTestKey(6).Public().(ed25519.PublicKey))
		}
		packages = append(packages, epochPackage)
	}
	record.PackagesDigest, err = PackagesDigest(packages)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CommitEpoch(ctx, resolve(owner), func(context.Context, SessionQuery, Principal, EpochRecord) error {
		return nil
	}, record, packages, nil); err != nil {
		t.Fatal(err)
	}
	appendMessage(record.KeyID, strings.Repeat("4", 32), 1)
	if multiBatch {
		extendPersonalDenyLiveBacklog(t, ctx, db, store, resolve(owner), actors[owner], record, packages, scopeAuthorityTestKey(1))
	}
	previousArchive := claimPurpose(owner, ArchiveEpoch, &cache)
	if previousArchive.ArchivePersonalDeny != nil {
		t.Fatal("archive evidence supplied before deny")
	}
	operation := strings.Repeat("2", 32)
	frame, err := SignatureFrame("pawtalk-protected-channel-acl-personal-edit-v1", serverID, cutover, editor, actors[editor].DeviceID,
		operation, "1", anchor.Digest, channel, "text", category, target, ChannelView, "deny")
	if err != nil {
		t.Fatal(err)
	}
	editorProof := base64.RawURLEncoding.EncodeToString(ed25519.Sign(scopeAuthorityTestKey(2), frame))
	intent := PolicyDraft{Action: EditScopedChannelACLPersonal, OperationID: operation, PreviousDigest: anchor.Digest,
		ResourceChange: &PolicyResourceChange{ID: channel, TargetProfileID: target, ACLPersonalEdit: &PolicyChannelACLPersonalEdit{
			CutoverDigest: cutover, Permission: ChannelView, Rule: "deny", EditorProof: editorProof,
			ServerKey: base64.RawURLEncoding.EncodeToString(scopeAuthorityTestKey(7).Public().(ed25519.PublicKey)),
		}}}
	successor, err := store.CommitScopedChannelACLPersonalEdit(ctx, resolve(editor), intent,
		func(context.Context, SessionQuery, Principal, PolicyDraft) ([]byte, error) {
			signature := make([]byte, 64)
			signature[0] = 2
			return signature, nil
		}, verifyPolicy)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(rotationPriorityMillis * time.Millisecond)
	unattested := claim(claimant, &cache)
	if unattested.LivePersonalDeny != nil {
		t.Fatal("transition exposed without a persisted predecessor attestation")
	}
	if unattestedArchive := claimPurpose(claimant, ArchiveEpoch, &cache); unattestedArchive.ArchivePersonalDeny != nil {
		t.Fatal("archive transition exposed without predecessor attestation")
	}
	nextRecord := unattested.EpochRecord
	nextRecord.KeyID, nextRecord.Signature = strings.Repeat("f", 64), make([]byte, 64)
	nextRecord.Signature[0] = 3
	nextPackages := make([]EpochPackage, 0, len(unattested.Recipients))
	for id := range unattested.Recipients {
		nextPackages = append(nextPackages, EpochPackage{RecipientID: id, Purpose: LiveEpoch, Ciphertext: make([]byte, EpochPackageSize)})
	}
	nextRecord.PackagesDigest, err = PackagesDigest(nextPackages)
	if err != nil {
		t.Fatal(err)
	}
	transition := PersonalDenyRotationEvidence{
		PreviousRevision: 1, PreviousHead: anchor.Digest, SuccessorHead: successor.Digest, OperationID: operation,
		Actor: actors[editor], TargetProfileID: target, EditorProof: editorProof,
	}
	nextRecord.LiveTransitionDigest, err = livePersonalDenyTransitionDigest(nextRecord, transition)
	if err != nil {
		t.Fatal(err)
	}
	claimantKey := scopeAuthorityTestKey(4)
	verifyEpoch := func(_ context.Context, _ SessionQuery, signer Principal, candidate EpochRecord) error {
		if multiBatch && candidate.Purpose == ArchiveEpoch && (signer != actors[claimant] ||
			!ed25519.Verify(claimantKey.Public().(ed25519.PublicKey), personalDenyBatchEpochFrame(candidate), candidate.Signature)) {
			return ErrEpochConflict
		}
		return nil
	}
	commitNext := func(candidate EpochRecord) error {
		return store.CommitEpoch(ctx, resolve(claimant), verifyEpoch, candidate, nextPackages, nil)
	}
	if err := commitNext(nextRecord); !errors.Is(err, ErrEpochConflict) {
		t.Fatalf("commit without predecessor attestation = %v", err)
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
			pinned string, view PolicyAttestation) error {
			frame, err := PolicyAttestationFrame(serverID, pinned, signer, view)
			if err != nil || !ed25519.Verify(ownerKey.Public().(ed25519.PublicKey), frame, view.Signature) {
				return ErrPolicySignatureRequired
			}
			return nil
		}, revision, ed25519.Sign(ownerKey, frame)); err != nil {
			t.Fatal(err)
		}
	}
	publish(anchor.Draft.Revision)
	after := claim(claimant, &cache)
	evidence := after.LivePersonalDeny
	if evidence == nil || evidence.PreviousHead != anchor.Digest || evidence.PreviousRevision != 1 ||
		evidence.SuccessorHead != successor.Digest || evidence.Actor != actors[editor] || evidence.TargetProfileID != target ||
		evidence.EditorProof != editorProof || evidence.OperationID != operation || len(after.Recipients) != 4 ||
		evidence.Authority.Actor != actors[editor] || evidence.PreviousTextPolicy.Recipient.Statement.RecipientID != actors[claimant].DeviceID ||
		evidence.RankBasis.Target.BypassesACL == nil || *evidence.RankBasis.Target.BypassesACL {
		t.Fatalf("incorrect live deny evidence: %+v", evidence)
	}
	if *evidence.PreviousTextPolicy.Rotation != *before.TextPolicy.Rotation {
		t.Fatal("predecessor audience changed")
	}
	if evidence.RemovedGroup == nil || len(evidence.SurvivorOpenings) != 4 || evidence.SurvivorOpenings[claimant] != before.RotationProfileOpenings[claimant] ||
		evidence.RemovedGroup.Salt != before.RotationProfileOpenings[target].Salt {
		t.Fatalf("invalid survivor/target opening: %+v", evidence)
	}
	removed, err := textRotationDigest(map[string]KeyRecipient{
		actors[target].DeviceID: before.Recipients[actors[target].DeviceID], recovery.ID: before.Recipients[recovery.ID],
	}, before.RotationProfileOpenings[target].ContentSalt)
	if err != nil || evidence.RemovedGroup.Digest != removed {
		t.Fatalf("wrong opaque removed digest: %v", err)
	}
	raw, err := json.Marshal(after)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{actors[target].DeviceID, recovery.ID, before.RotationProfileOpenings[target].ContentSalt,
		`"rules":`, `"rulesSalt":`, `"synchronized":`, "message.pin"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("live rotation disclosed private predecessor material: %s", forbidden)
		}
	}
	if unscoped := claim(claimant, nil); unscoped.LivePersonalDeny != nil {
		t.Fatal("unscoped task disclosed predecessor evidence")
	}
	err = store.DispatchRotationTask(ctx, resolve(target), channel, LiveEpoch, &cache, func(RotationTask) error {
		t.Fatal("revoked target obtained a task")
		return nil
	})
	if !errors.Is(err, ChannelRestricted) {
		t.Fatalf("revoked target claim = %v", err)
	}
	snapshot, _, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	forged := after
	forged.Recipients = maps.Clone(after.Recipients)
	delete(forged.Recipients, actors[owner].DeviceID)
	witness, err := livePersonalDenyEvidence(ctx, db, snapshot, successor, forged, actors[claimant], &cache.history)
	if err != nil || witness != nil {
		t.Fatalf("incomplete new audience received a transition witness: %+v, %v", witness, err)
	}
	mismatch := nextRecord
	transition.SuccessorHead = strings.Repeat("1", 64)
	mismatch.LiveTransitionDigest, err = livePersonalDenyTransitionDigest(nextRecord, transition)
	if err != nil {
		t.Fatal(err)
	}
	if err := commitNext(mismatch); !errors.Is(err, ErrEpochConflict) {
		t.Fatalf("commit with different successor head = %v", err)
	}
	if err := commitNext(nextRecord); err != nil {
		t.Fatal(err)
	}
	var firstArchive EpochRecord
	if multiBatch {
		firstArchive = commitFirstPersonalDenyArchiveBatch(t, ctx, store, claimPurpose(claimant, ArchiveEpoch, &cache),
			resolve(claimant), verifyEpoch, claimantKey)
	}
	now = now.Add(rotationLeaseMillis * time.Millisecond)
	archive := claimPurpose(claimant, ArchiveEpoch, &cache)
	if archive.LivePersonalDeny != nil {
		t.Fatal("archive claim disclosed live witness")
	}
	archiveRecord := archive.EpochRecord
	archiveRecord.KeyID = strings.Repeat("b", 64)
	archiveRecord.ArchiveWrapKey = recoveryTestAgreementKey(t, 9)
	archiveRecord.Signature = make([]byte, 64)
	archiveRecord.Signature[0] = 4
	archivePackages := make([]EpochPackage, 0, len(archive.Recipients))
	for id := range archive.Recipients {
		archivePackages = append(archivePackages, EpochPackage{RecipientID: id, Purpose: ArchiveEpoch, Ciphertext: make([]byte, EpochPackageSize)})
	}
	archiveRecord.PackagesDigest, err = PackagesDigest(archivePackages)
	if err != nil {
		t.Fatal(err)
	}
	archiveLinks := make([]ArchiveLink, 0, len(archive.ArchiveTargets))
	for _, link := range archive.ArchiveTargets {
		archiveLinks = append(archiveLinks, ArchiveLink{ArchiveTarget: link, Ciphertext: make([]byte, ArchiveLinkSize)})
	}
	archiveRecord.ArchiveLinksDigest, err = ArchiveLinksDigest(archiveLinks)
	if err != nil || archiveRecord.ArchiveThrough != nextRecord.Generation {
		t.Fatalf("archive fixture missed new live generation: %v", err)
	}
	transition.SuccessorHead = successor.Digest
	archiveRecord.ArchiveTransitionDigest, err = personalDenyTransitionDigest(archiveRecord, transition)
	if err != nil {
		t.Fatal(err)
	}
	commitArchive := func(candidate EpochRecord, links []ArchiveLink) error {
		if multiBatch {
			candidate.Signature = ed25519.Sign(claimantKey, personalDenyBatchEpochFrame(candidate))
		}
		return store.CommitEpoch(ctx, resolve(claimant), verifyEpoch, candidate, archivePackages, links)
	}
	if version >= TextGroupedArchiveRotationProjectionVersion {
		archiveWitness := archive.ArchivePersonalDeny
		if archiveWitness == nil || archiveWitness.PreviousHead != anchor.Digest || archiveWitness.SuccessorHead != successor.Digest ||
			archiveWitness.TargetProfileID != target || archiveWitness.Actor != actors[editor] ||
			archiveWitness.PreviousTextPolicy.Recipient.Statement.RecipientID != actors[claimant].DeviceID ||
			!archiveWitness.PreviousTextPolicy.Recipient.Statement.Archive ||
			archiveWitness.PreviousTextPolicy.Rotation.ArchiveProfiles != previousArchive.TextPolicy.Rotation.ArchiveProfiles ||
			len(archiveWitness.SurvivorOpenings) != 2 ||
			archiveWitness.SurvivorOpenings[claimant] != previousArchive.RotationProfileOpenings[claimant] {
			t.Fatalf("incorrect archive transition: %+v", archiveWitness)
		}
		encoded, err := json.Marshal(archive)
		if err != nil {
			t.Fatal(err)
		}
		privateFields := []string{actors[target].DeviceID, recovery.ID, evidence.RemovedGroup.Salt, evidence.SurvivorOpenings[claimant].ContentSalt}
		if archiveTarget {
			opening := previousArchive.RotationProfileOpenings[target]
			archiveDigest, err := textRotationDigest(map[string]KeyRecipient{
				actors[target].DeviceID: previousArchive.Recipients[actors[target].DeviceID], recovery.ID: previousArchive.Recipients[recovery.ID],
			}, opening.ContentSalt)
			if err != nil || archiveWitness.RemovedGroup == nil || archiveWitness.RemovedGroup.Salt != opening.Salt ||
				archiveWitness.RemovedGroup.Digest != archiveDigest || archiveDigest == evidence.RemovedGroup.Digest {
				t.Fatalf("wrong opaque removed archive group: %+v, %v", archiveWitness.RemovedGroup, err)
			}
			privateFields = append(privateFields, opening.ContentSalt)
		} else {
			if archiveWitness.RemovedGroup != nil || strings.Contains(string(encoded), `"removedGroup":`) ||
				!maps.Equal(archive.Recipients, previousArchive.Recipients) ||
				!maps.Equal(archiveWitness.SurvivorOpenings, previousArchive.RotationProfileOpenings) {
				t.Fatalf("archive witness did not preserve the exact previous roster: %+v", archiveWitness)
			}
			forged := archive
			forged.Recipients = maps.Clone(archive.Recipients)
			delete(forged.Recipients, actors[owner].DeviceID)
			if proof, err := personalDenyRotationEvidence(ctx, db, snapshot, successor, forged, actors[claimant], &cache.history); err != nil || proof != nil {
				t.Fatalf("archive without removal accepted a different roster: %+v %v", proof, err)
			}
		}
		for _, private := range privateFields {
			if strings.Contains(string(encoded), private) {
				t.Fatalf("archive witness exposed a private opening or unrelated recipient: %s", private)
			}
		}
		if unscoped := claimPurpose(claimant, ArchiveEpoch, nil); unscoped.ArchivePersonalDeny != nil {
			t.Fatal("unscoped archive claim disclosed predecessor evidence")
		}
		assertScopedPersonalDenyArchiveSource(t, ctx, store, resolve(claimant), resolve(viewer), archive, nextRecord, actors[claimant],
			target, verifyEpoch, &cache, actors[target].DeviceID, recovery.ID)
		malformed := archiveRecord
		malformed.ArchiveWrapKey = ""
		if err := commitArchive(malformed, archiveLinks); !errors.Is(err, InvalidAction) {
			t.Fatalf("archive transition without wrap key = %v", err)
		}
		mixed := archiveRecord
		mixed.LiveTransitionDigest = nextRecord.LiveTransitionDigest
		if err := commitArchive(mixed, archiveLinks); !errors.Is(err, InvalidAction) {
			t.Fatalf("mixed epoch digests = %v", err)
		}
		wrongDomain := archiveRecord
		wrongDomain.ArchiveTransitionDigest = nextRecord.LiveTransitionDigest
		if err := commitArchive(wrongDomain, archiveLinks); !errors.Is(err, ErrEpochConflict) {
			t.Fatalf("archive transition accepted live digest = %v", err)
		}
		if err := commitArchive(archiveRecord, archiveLinks[:len(archiveLinks)-1]); !errors.Is(err, ErrEpochConflict) {
			t.Fatalf("archive transition skipped omitted target = %v", err)
		}
	} else {
		if archive.ArchivePersonalDeny != nil {
			t.Fatalf("archive witness issued before v14: %+v", archive.ArchivePersonalDeny)
		}
		if err := commitArchive(archiveRecord, archiveLinks); !errors.Is(err, ErrEpochConflict) {
			t.Fatalf("archive commit accepted transition before v14: %v", err)
		}
		archiveRecord.ArchiveTransitionDigest = ""
	}
	if multiBatch {
		archiveRecord.Signature = ed25519.Sign(claimantKey, personalDenyBatchEpochFrame(archiveRecord))
	}
	if err := commitArchive(archiveRecord, archiveLinks); err != nil {
		t.Fatal(err)
	}
	persistedArchive, err := readEpoch(ctx, db, channel, ArchiveEpoch, archiveRecord.KeyID)
	if err != nil || persistedArchive.Record.ArchiveTransitionDigest != archiveRecord.ArchiveTransitionDigest {
		t.Fatalf("archive transition lost on round trip: %+v %v", persistedArchive, err)
	}
	if archiveRecord.ArchiveTransitionDigest != "" {
		assertScopedPersonalDenyArchiveRead(t, ctx, store, resolve(owner), resolve(viewer), resolve(target), archiveRecord,
			actors[owner], actors[claimant], archive.ArchivePersonalDeny, verifyEpoch, &cache, actors[target].DeviceID, recovery.ID)
	}
	if multiBatch {
		assertMarkedArchiveProofPage(t, ctx, store, resolve(owner), actors[owner], firstArchive, archiveRecord, verifyEpoch, &cache, true)
	}
	var verifyEditedOriginal VerifyRevision
	if version == TextGroupedRevisionAudienceProjectionVersion {
		verifyEditedOriginal = publishPersonalDenyEditedOriginal(t, ctx, store, resolve(editor), actors[editor], actors[claimant], scopeAuthorityTestKey(2),
			channel, target, 1, verifyEpoch, &cache, !archiveTarget, actors[target].DeviceID, recovery.ID)
		assertPersonalDenyEditedOriginalRead(t, ctx, store, resolve(owner), resolve(viewer), resolve(target), actors[viewer],
			actors[editor], actors[claimant], channel, 1, anchor, successor, verifyEpoch, verifyEditedOriginal, &cache, actors[target].DeviceID, recovery.ID)
	}
	load := func(profile string, scoped bool) (EpochPackageDelivery, error) {
		t.Helper()
		var delivery EpochPackageDelivery
		err := store.DispatchCurrentEpochPackage(ctx, resolve(profile), channel, LiveEpoch, verifyEpoch, &cache, scoped, nil,
			func(value EpochPackageDelivery) error { delivery = value; return nil })
		return delivery, err
	}
	delivery, err := load(viewer, true)
	if err != nil {
		t.Fatal(err)
	}
	opened := delivery.LivePersonalDeny
	if opened == nil || opened.PreviousRevision != anchor.Draft.Revision || opened.PreviousHead != anchor.Digest ||
		opened.SuccessorHead != successor.Digest || opened.Actor != actors[editor] || opened.OperationID != operation ||
		opened.TargetProfileID != target || opened.EditorProof != editorProof ||
		opened.PreviousTextPolicy.Recipient.Statement.RecipientID != actors[viewer].DeviceID ||
		opened.PreviousSignerTextPolicy.Recipient.Statement.RecipientID != actors[claimant].DeviceID ||
		delivery.Package.RecipientID != actors[viewer].DeviceID || delivery.Epoch.Record.LiveTransitionDigest != nextRecord.LiveTransitionDigest {
		t.Fatalf("incorrect scoped read witness before successor attestation: %+v", delivery)
	}
	encoded, err := json.Marshal(opened)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{owner, actors[owner].DeviceID, actors[target].DeviceID, recovery.ID,
		evidence.RemovedGroup.Salt, evidence.RemovedGroup.Digest, `"removedGroup":`, `"survivorOpenings":`, `"rules":`, `"rulesSalt":`, "message.pin"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("delivery witness disclosed unrelated historical material: %s", forbidden)
		}
	}
	if unscoped, err := load(viewer, false); err != nil || unscoped.LivePersonalDeny != nil {
		t.Fatalf("unscoped delivery contained a transition witness: %+v %v", unscoped.LivePersonalDeny, err)
	}
	if _, err := load(target, true); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("revoked target obtained a scoped delivery: %v", err)
	}
	appendMessage(nextRecord.KeyID, strings.Repeat("5", 32), 1)
	appendMessage(nextRecord.KeyID, strings.Repeat("6", 32), 2)
	t.Run("scoped message author on predecessor", func(t *testing.T) {
		readPage := func(verify VerifyEpochRecord) LiveMessagePage {
			t.Helper()
			var page LiveMessagePage
			err := store.DispatchLiveMessages(ctx, resolve(viewer), channel, 0, 8, &cache, false,
				func(value LiveMessagePage) error { page = value; return nil }, verify)
			if err != nil || len(page.Messages) != 3 {
				t.Fatalf("visible live messages = %d, %v", len(page.Messages), err)
			}
			return page
		}
		verified := 0
		page := readPage(func(_ context.Context, _ SessionQuery, actor Principal, record EpochRecord) error {
			verified++
			if actor != actors[claimant] || record.KeyID != nextRecord.KeyID {
				t.Fatalf("verified unrelated epoch for fallback: %s %+v", record.KeyID, actor)
			}
			return nil
		})
		if verified != 1 || page.Messages[0].AuthorPolicy == nil || page.Messages[0].PreviousAuthorPolicy != nil {
			t.Fatalf("unmarked history or marked epoch verification changed: %d %+v", verified, page.Messages[0])
		}
		for _, message := range page.Messages[1:] {
			previous := message.PreviousAuthorPolicy
			if message.AuthorPolicy == nil || message.AuthorPolicy.Revision != successor.Draft.Revision ||
				previous == nil || previous.Revision != anchor.Draft.Revision || previous.PolicyDigest != anchor.Draft.ResultDigest ||
				previous.Recipient.Statement.RecipientID != actors[editor].DeviceID ||
				previous.Recipient.Statement.CanSend == nil || !*previous.Recipient.Statement.CanSend {
				t.Fatalf("visible author proof at position %d: current=%+v preceding=%+v", message.Position, message.AuthorPolicy, previous)
			}
		}
		encoded, err := json.Marshal(page.Messages[1])
		if err != nil || !strings.Contains(string(encoded), `"previousAuthorPolicy":`) ||
			strings.Contains(string(encoded), actors[target].DeviceID) || strings.Contains(string(encoded), actors[claimant].DeviceID) {
			t.Fatalf("unexpected message proof wire fields: %s %v", encoded, err)
		}
		unverified := readPage(func(context.Context, SessionQuery, Principal, EpochRecord) error { return ErrEpochConflict })
		if unverified.Messages[1].AuthorPolicy == nil || unverified.Messages[1].PreviousAuthorPolicy != nil {
			t.Fatal("unverified epoch exposed the predecessor proof or lost normal author evidence")
		}
		var tree textChannelPolicyTreeCache
		basis, err := readLiveMessageAuthorBasis(ctx, db, channel, nextRecord.KeyID, &tree, verifyEpoch)
		if err != nil {
			t.Fatal(err)
		}
		for _, author := range []Principal{actors[target], actors[claimant], {ProfileID: editor, DeviceID: actors[viewer].DeviceID}} {
			if proof, err := basis.previousAuthorDisclosure(author, &tree); err != nil || proof != nil {
				t.Fatalf("ineligible old author %+v received a proof: %+v %v", author, proof, err)
			}
		}
	})
	if version < TextGroupedRevisionAudienceProjectionVersion {
		publish(successor.Draft.Revision)
		if attested, err := livePersonalDenyEvidence(ctx, db, snapshot, successor, after, actors[claimant], &cache.history); err != nil || attested == nil {
			t.Fatalf("current owner attestation unnecessarily suppressed the same eligible transition witness: %v", err)
		}
	}
	persisted, err := readEpoch(ctx, db, channel, LiveEpoch, nextRecord.KeyID)
	if err != nil || persisted.Record.LiveTransitionDigest != nextRecord.LiveTransitionDigest {
		t.Fatalf("signed transition lost on round trip: %+v %v", persisted, err)
	}
	if err := commitNext(nextRecord); !errors.Is(err, ErrEpochConflict) {
		t.Fatalf("repeated commit = %v", err)
	}
	later, err := store.PreviewPolicy(ctx, resolve(owner), PolicyDraft{Action: EditPolicyChannel, OperationID: strings.Repeat("3", 32),
		ResourceChange: &PolicyResourceChange{ID: channel, Settings: &ChannelSettings{Name: "Updated settings", SlowmodeSeconds: 2}}})
	if err != nil {
		t.Fatal(err)
	}
	later.Signature = make([]byte, 64)
	later.Signature[0] = 3
	if _, err := store.CommitPolicy(ctx, resolve(owner), verifyPolicy, later); err != nil {
		t.Fatal(err)
	}
	publish(later.Revision)
	if previous, err := load(viewer, true); err != nil || previous.LivePersonalDeny == nil ||
		previous.LivePersonalDeny.SuccessorHead != successor.Digest || previous.Epoch.Record.KeyID != nextRecord.KeyID ||
		previous.TextPolicy == nil || previous.TextPolicy.Revision != later.Revision {
		t.Fatalf("current live package lost its immutable transition after a settings edit: %+v %v", previous, err)
	}
	if archiveRecord.ArchiveTransitionDigest != "" {
		assertScopedPersonalDenyArchiveRead(t, ctx, store, resolve(owner), resolve(viewer), resolve(target), archiveRecord,
			actors[owner], actors[claimant], archive.ArchivePersonalDeny, verifyEpoch, &cache, actors[target].DeviceID, recovery.ID)
	}
	if _, err := load(target, true); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("later settings edit reopened revoked access: %v", err)
	}
	if multiBatch {
		assertMarkedArchiveProofPage(t, ctx, store, resolve(owner), actors[owner], firstArchive, archiveRecord, verifyEpoch, &cache, false)
	}
	if verifyEditedOriginal != nil {
		assertPersonalDenyEditedOriginalRead(t, ctx, store, resolve(owner), resolve(viewer), resolve(target), actors[viewer],
			actors[editor], actors[claimant], channel, 1, anchor, successor, verifyEpoch, verifyEditedOriginal, &cache, actors[target].DeviceID, recovery.ID)
	}
}

func TestPersonalDenyTransitionDigestVectors(t *testing.T) {
	record := EpochRecord{ChannelID: strings.Repeat("4", 32), Revision: 8, PolicyDigest: strings.Repeat("c", 64)}
	evidence := PersonalDenyRotationEvidence{
		PreviousRevision: 7, PreviousHead: strings.Repeat("a", 64),
		SuccessorHead: strings.Repeat("b", 64), OperationID: strings.Repeat("1", 32),
		Actor:           Principal{ProfileID: strings.Repeat("d", 64), DeviceID: strings.Repeat("e", 64)},
		TargetProfileID: strings.Repeat("f", 64), EditorProof: strings.Repeat("a", 86),
	}
	for _, test := range []struct{ purpose, want string }{
		{LiveEpoch, "59447040745488caf8096c3d679d864f18bd0892045b16b543b386208b4d476c"},
		{ArchiveEpoch, "7fa6e5babb8a9b84b1f9a2ad1a390d9b8ff54cb737a171543af911210a5a390f"},
	} {
		record.Purpose = test.purpose
		digest, err := personalDenyTransitionDigest(record, evidence)
		if err != nil || digest != test.want {
			t.Fatalf("%s transition digest = %q, %v", test.purpose, digest, err)
		}
	}
}
