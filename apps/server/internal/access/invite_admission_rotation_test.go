package access

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"strings"
	"testing"
)

func TestScopedInviteLiveRotation(t *testing.T) {
	testScopedInviteRotation(t, false, TextNewcomerAdmissionProjectionVersion)
	t.Run("v18", func(t *testing.T) { testScopedInviteRotation(t, false, ProfileRoleAuthorityProjectionVersion) })
}

func TestScopedFullHistoryInviteRotation(t *testing.T) {
	testScopedInviteRotation(t, true, TextNewcomerAdmissionProjectionVersion)
	t.Run("v18", func(t *testing.T) { testScopedInviteRotation(t, true, ProfileRoleAuthorityProjectionVersion) })
}

func testScopedInviteRotation(t *testing.T, fullHistory bool, version int) {
	t.Helper()
	channel, inviteID, operation := strings.Repeat("9", 32), strings.Repeat("3", 32), strings.Repeat("4", 32)
	seed := strings.Repeat("aa", 32)
	claimantKey := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(1))
	claimant := Principal{ProfileID: strings.Repeat("1", 64), DeviceID: hexHash(parseScopeAuthorityKey(claimantKey))}
	entrantKey := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(2))
	profileKey := parseScopeAuthorityKey(scopeAuthorityTestPublicKey(scopeAuthorityTestKey(3)))
	entrant := Principal{ProfileID: hexHash(profileKey), DeviceID: hexHash(parseScopeAuthorityKey(entrantKey))}
	claim := InviteRedeem{InviteID: inviteID, OperationID: operation, AgreementKey: recoveryTestAgreementKey(t, 24),
		DevicePublicKey:  base64.RawURLEncoding.EncodeToString(parseScopeAuthorityKey(entrantKey)),
		ProfilePublicKey: base64.RawURLEncoding.EncodeToString(profileKey)}
	issue := InviteIssuance{Issuer: claimant, PolicyRevision: 6, PolicyDigest: strings.Repeat("b", 64), MaxUses: 3, Signature: "fixture-issue"}
	grants := []string{ChannelView, "message.send"}
	if fullHistory {
		grants = append(grants, "history.full")
	}
	old := State{
		RoleSnapshot: RoleSnapshot{
			Policy:  Policy{Owner: claimant.ProfileID, Roles: map[string]Role{Everyone: {Grants: grants}}},
			Members: map[string]Subject{claimant.ProfileID: {ID: claimant.ProfileID, Active: true}},
		},
		Channels:      map[string]Channel{channel: {Kind: "text", NextPosition: 8}},
		Admissions:    map[string]map[string]Admission{channel: {claimant.ProfileID: {FirstPosition: 1}}},
		KeyRecipients: map[string]KeyRecipient{claimant.DeviceID: {ProfileID: claimant.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, 23)}},
		PolicyDevices: map[string]PolicyDevice{claimant.DeviceID: {ProfileID: claimant.ProfileID, PublicKey: claimantKey}},
		InvitationUses: map[string]InvitePolicyUse{
			inviteID: {IssueSignature: issue.Signature, Count: 1},
		},
		PolicyAnchored: true,
	}
	current := old
	current.Members = maps.Clone(old.Members)
	current.Members[entrant.ProfileID] = Subject{ID: entrant.ProfileID, Active: true}
	current.PolicyDevices = maps.Clone(old.PolicyDevices)
	current.PolicyDevices[entrant.DeviceID] = PolicyDevice{ProfileID: entrant.ProfileID, PublicKey: entrantKey}
	current.KeyRecipients = maps.Clone(old.KeyRecipients)
	current.KeyRecipients[entrant.DeviceID] = KeyRecipient{ProfileID: entrant.ProfileID, Kind: "device", PublicKey: claim.AgreementKey}
	current.InvitationUses = map[string]InvitePolicyUse{inviteID: {IssueSignature: issue.Signature, Count: 2}}
	current.refreshAdmissions()
	if current.Admissions[channel][entrant.ProfileID].FirstPosition != 8 ||
		current.CanDeliver(entrant.ProfileID, channel, 7) != fullHistory ||
		current.canLoadEpoch(entrant, channel, ArchiveEpoch) != fullHistory {
		t.Fatal("fixture entrant did not inherit the configured history grant")
	}
	projection, err := old.textProjectionTree(seed, version)
	if err != nil {
		t.Fatal(err)
	}
	successorProjection, err := current.textProjectionTree(seed, version)
	if err != nil {
		t.Fatal(err)
	}
	predecessor := PolicyProof{Digest: issue.PolicyDigest, Draft: PolicyDraft{
		Revision: 6, TextProjectionVersion: version, TextProjectionRoot: projection.root(), TextProjectionSeed: seed,
		ResultDigest: strings.Repeat("c", 64),
	}}
	admission := InvitePolicyAdmission{CutoverDigest: strings.Repeat("d", 64), Claim: claim, Issuance: &issue}
	head := PolicyProof{Principal: entrant, Digest: strings.Repeat("e", 64), Draft: PolicyDraft{
		Revision: 7, Action: RedeemPolicyInvite, PreviousDigest: predecessor.Digest, ResultDigest: strings.Repeat("f", 64),
		OperationID: operation, TextProjectionVersion: version, TextProjectionSeed: seed, TextProjectionRoot: successorProjection.root(),
		ResourceChange: &PolicyResourceChange{ID: entrant.ProfileID, Admission: &admission},
	}}
	task := RotationTask{
		EpochRecord: EpochRecord{ChannelID: channel, Purpose: LiveEpoch, Revision: 7, PolicyDigest: head.Draft.ResultDigest},
		Recipients:  current.KeyRecipients,
	}
	receipt := ScopedInviteReceipt{Revision: 7, PreviousDigest: predecessor.Digest, ResultDigest: head.Draft.ResultDigest,
		ProjectionRoot: successorProjection.root(), Digest: head.Digest, OperationID: operation, Actor: entrant,
		Admission: admission, Signature: bytes.Repeat([]byte{5}, 64)}
	var cache textChannelPolicyTreeCache
	build := func(before, after State, work RotationTask, caller Principal, receipt ScopedInviteReceipt) *InviteAdmissionRotationEvidence {
		t.Helper()
		witness, err := buildInviteAdmissionRotationEvidence(before, after, old, predecessor, head, predecessor, work, caller, &receipt, &cache)
		if err != nil {
			t.Fatal(err)
		}
		return witness
	}
	witness := build(old, current, task, claimant, receipt)
	if witness == nil || witness.PreviousTextPolicy.Recipient == nil ||
		!witness.Newcomer.Visible || !witness.Newcomer.CanSend || witness.Newcomer.Archive != fullHistory ||
		witness.NewcomerTextPolicy.Recipient.Statement.FirstPosition != 8 ||
		len(witness.PreviousOpenings) != 1 || witness.PreviousOpenings[claimant.ProfileID].ContentSalt == "" ||
		witness.Freshness.Use.Count != 1 || witness.Freshness.Use.IssueSignature != issue.Signature ||
		witness.Freshness.Profile == nil || witness.Freshness.Device == nil || witness.Freshness.Agreement == nil ||
		witness.IssuerAuthority.Opening.SigningKey != claimantKey {
		t.Fatalf("incomplete admission witness: %+v", witness)
	}
	if raw, err := json.Marshal(witness); err != nil || bytes.Contains(raw, []byte(seed)) ||
		bytes.Contains(raw, []byte("TextProjectionSeed")) || bytes.Contains(raw, []byte("InvitationUses")) {
		t.Fatalf("admission witness leaked private projection inputs: %s, %v", raw, err)
	}
	digest, err := inviteAdmissionTransitionDigest(task.EpochRecord, *witness)
	if err != nil || digest != "9cc7fea094540ae6b11988cdae16fb02fe2d1535a34858253870eff8f6a0dc37" {
		t.Fatalf("admission marker digest: %s, %v", digest, err)
	}
	archiveTask := task
	archiveTask.Purpose, archiveTask.ArchiveThrough = ArchiveEpoch, 2
	archiveWitness := build(old, current, archiveTask, claimant, receipt)
	if !fullHistory && archiveWitness != nil {
		t.Fatal("limited newcomer received archive rotation evidence")
	}
	if fullHistory {
		if archiveWitness == nil || !archiveWitness.Newcomer.Archive ||
			archiveWitness.PreviousOpenings[claimant.ProfileID] == witness.PreviousOpenings[claimant.ProfileID] {
			t.Fatalf("archive evidence must commit the archive group: %+v", archiveWitness)
		}
		archiveDigest, err := inviteAdmissionTransitionDigest(archiveTask.EpochRecord, *archiveWitness)
		if err != nil || archiveDigest != "6d3663e2a97fa8004d7577403d18e73a86083384a4ae6e5f021181d9cf46aecd" {
			t.Fatalf("archive invitation marker digest: %s, %v", archiveDigest, err)
		}
		archiveBasis := inviteAdmissionRotationBasis{previous: old, predecessor: predecessor, rotation: archiveWitness}
		packageProof, err := archiveBasis.disclosePackage(current, current, archiveTask.EpochRecord, entrant, &cache)
		if err != nil || packageProof == nil || packageProof.PreviousTextPolicy != nil {
			t.Fatalf("newcomer archive package used a nonexistent predecessor admission: %+v, %v", packageProof, err)
		}
		if build(old, current, archiveTask, entrant, receipt) != nil {
			t.Fatal("newcomer cannot rotate archive without the old sources")
		}
		checkArchiveInviteLiveSource(t, current, archiveTask.EpochRecord, claimant, *archiveWitness)
	}
	if build(old, current, task, entrant, receipt) != nil {
		t.Fatal("entrant cannot perform a transition using a key it never held")
	}
	wrongAudience := task
	wrongAudience.Recipients = maps.Clone(task.Recipients)
	delete(wrongAudience.Recipients, claimant.DeviceID)
	wrongAudience.Recipients[strings.Repeat("5", 64)] = task.Recipients[claimant.DeviceID]
	if build(old, current, wrongAudience, claimant, receipt) != nil {
		t.Fatal("replacing a survivor must not be authenticated as one addition")
	}
	wrongReceipt := receipt
	wrongReceipt.Digest = predecessor.Digest
	if build(old, current, task, claimant, wrongReceipt) != nil {
		t.Fatal("admission receipt for the wrong successor was accepted")
	}
	wrongReceipt = receipt
	wrongReceipt.ProjectionRoot = predecessor.Draft.TextProjectionRoot
	if build(old, current, task, claimant, wrongReceipt) != nil {
		t.Fatal("admission receipt for the wrong projection root was accepted")
	}
	wrongUse := current
	wrongUse.InvitationUses = old.InvitationUses
	if build(old, wrongUse, task, claimant, receipt) != nil {
		t.Fatal("admission without one committed use was accepted")
	}
	if !validTextProjectionFields(predecessor.Draft) || !validTextProjectionFields(head.Draft) {
		t.Fatal("v17 drafts must support the committed predecessor and successor projections")
	}
	basis := inviteAdmissionRotationBasis{previous: old, predecessor: predecessor, rotation: witness}
	entrantProof, err := basis.disclosePackage(current, current, task.EpochRecord, entrant, &cache)
	if err != nil || entrantProof == nil || entrantProof.PreviousTextPolicy != nil ||
		entrantProof.NewcomerTextPolicy.Recipient.Statement.FirstPosition != 8 {
		t.Fatalf("entrant package proof used a predecessor admission or wrong floor: %+v, %v", entrantProof, err)
	}
	retainedProof, err := basis.disclosePackage(current, current, task.EpochRecord, claimant, &cache)
	if err != nil || retainedProof == nil || retainedProof.PreviousTextPolicy.Recipient.Statement.FirstPosition != 1 ||
		retainedProof.PreviousSignerTextPolicy.Recipient.Statement.FirstPosition != 1 {
		t.Fatalf("retained reader proof omitted addressed floors: %+v, %v", retainedProof, err)
	}
	raw, err := json.Marshal(retainedProof)
	if err != nil || bytes.Contains(raw, []byte("previousOpenings")) || bytes.Contains(raw, []byte("Recipients")) {
		t.Fatalf("compact proof leaked the historical roster: %s, %v", raw, err)
	}
	readmitted := current
	readmitted.Admissions = map[string]map[string]Admission{channel: maps.Clone(current.Admissions[channel])}
	readmitted.Admissions[channel][entrant.ProfileID] = Admission{FirstPosition: 9}
	if got, err := basis.disclosePackage(current, readmitted, task.EpochRecord, entrant, &cache); got != nil || err != ChannelRestricted {
		t.Fatalf("changed admission interval recovered old LIVE proof: %+v, %v", got, err)
	}
}

func checkArchiveInviteLiveSource(t *testing.T, state State, archive EpochRecord, signer Principal, evidence InviteAdmissionRotationEvidence) {
	t.Helper()
	ctx := context.Background()
	db, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "invite-archive-source.sqlite")))
	if err := store.Initialize(ctx, testPolicyState()); err != nil {
		t.Fatal(err)
	}
	live := EpochRecord{ChannelID: archive.ChannelID, Purpose: LiveEpoch, Generation: 3, Revision: archive.Revision,
		PolicyDigest: archive.PolicyDigest, KeyID: strings.Repeat("1", 64), TaskID: strings.Repeat("2", 32),
		Signature: bytes.Repeat([]byte{3}, 64)}
	var err error
	live.LiveTransitionDigest, err = inviteAdmissionTransitionDigest(live, evidence)
	if err != nil {
		t.Fatal(err)
	}
	state.EpochWindows = map[string]EpochWindow{archive.ChannelID: {Current: live.Generation}}
	archive.ArchiveThrough = live.Generation - 1
	persist := func(record EpochRecord) {
		t.Helper()
		raw, err := json.Marshal(EpochProof{Principal: signer, Record: record})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO protected_epochs(channel_id,purpose,generation,key_id,task_id,digest,record)
			VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id,purpose,generation) DO UPDATE SET digest=excluded.digest,record=excluded.record`,
			record.ChannelID, record.Purpose, record.Generation, record.KeyID, record.TaskID, hexHash(record.Signature), raw); err != nil {
			t.Fatal(err)
		}
	}
	persist(live)
	verified := false
	verify := func(_ context.Context, _ SessionQuery, actor Principal, record EpochRecord) error {
		if actor != signer || record.LiveTransitionDigest != live.LiveTransitionDigest {
			t.Fatal("verification did not receive the exact matching live epoch")
		}
		verified = true
		return nil
	}
	if got, err := archiveInviteLiveSource(ctx, db, state, archive, evidence, verify); err != nil || !got || !verified {
		t.Fatalf("archive batch could not use exact newest LIVE source: %v, %v", got, err)
	}
	invalid := errors.New("synthetic invalid LIVE epoch signature")
	reject := func(context.Context, SessionQuery, Principal, EpochRecord) error { return invalid }
	if got, err := archiveInviteLiveSource(ctx, db, state, archive, evidence, reject); got || !errors.Is(err, invalid) {
		t.Fatalf("archive marker accepted an unverified LIVE source: %v, %v", got, err)
	}
	for _, change := range []func(*EpochRecord){
		func(record *EpochRecord) { record.LiveTransitionDigest = "" },
		func(record *EpochRecord) { record.LiveTransitionDigest = strings.Repeat("9", 64) },
		func(record *EpochRecord) { record.Revision++ },
	} {
		changed := live
		change(&changed)
		persist(changed)
		if got, err := archiveInviteLiveSource(ctx, db, state, archive, evidence, nil); got || err != nil {
			t.Fatalf("archive witness produced for unrelated live head: %v, %v", got, err)
		}
	}
}
