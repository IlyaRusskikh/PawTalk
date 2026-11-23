package access

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"maps"
	"path/filepath"
	"strings"
	"testing"
)

func TestInviteAdmissionBatchReceiptBasis(t *testing.T) {
	for _, version := range []int{TextNewcomerAdmissionProjectionVersion, ProfileRoleAuthorityProjectionVersion} {
		t.Run(fmt.Sprintf("v%d limited history", version), func(t *testing.T) { testInviteAdmissionBatchReceiptBasis(t, false, version) })
		t.Run(fmt.Sprintf("v%d full history", version), func(t *testing.T) { testInviteAdmissionBatchReceiptBasis(t, true, version) })
	}
}

func testInviteAdmissionBatchReceiptBasis(t *testing.T, fullHistory bool, version int) {
	t.Helper()
	ctx := context.Background()
	db, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "invite-batch.sqlite")))
	channel, inviteID := strings.Repeat("5", 32), strings.Repeat("6", 32)
	signer := scopeAuthorityTestKey(90)
	signerKey := scopeAuthorityTestPublicKey(signer)
	owner := Principal{ProfileID: strings.Repeat("1", 64), DeviceID: hexHash(parseScopeAuthorityKey(signerKey))}
	serverKey := scopeAuthorityTestKey(91)
	serverPublic := serverKey.Public().(ed25519.PublicKey)
	serverID := hexHash(serverPublic)[:32]
	grants := []string{ChannelView, "message.send"}
	if fullHistory {
		grants = append(grants, "history.full")
	}
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner.ProfileID, Roles: map[string]Role{
				Everyone: {Grants: grants},
			}},
			Members: map[string]Subject{owner.ProfileID: {ID: owner.ProfileID, Active: true}},
		},
		Channels:      map[string]Channel{channel: {Kind: "text", NextPosition: 1}},
		PolicyDevices: map[string]PolicyDevice{owner.DeviceID: {ProfileID: owner.ProfileID, PublicKey: signerKey}},
		KeyRecipients: map[string]KeyRecipient{owner.DeviceID: {ProfileID: owner.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, 90)}},
		InvitationUses: map[string]InvitePolicyUse{
			inviteID: {IssueSignature: "fixture-issuer-signature", Count: 1},
		},
		PolicyAnchored: true,
	}
	state.refreshAdmissions()
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "CREATE TABLE server_state(id INTEGER PRIMARY KEY,server_id TEXT,identity_public_key BLOB); INSERT INTO server_state VALUES(1,?,?)", serverID, []byte(serverPublic)); err != nil {
		t.Fatal(err)
	}
	persist := func(actor Principal, draft PolicyDraft) PolicyProof {
		t.Helper()
		draft.TextProjectionVersion = version
		draft.TextProjectionSeed = fmt.Sprintf("%064x", draft.Revision)
		tree, err := state.textProjectionTree(draft.TextProjectionSeed, version)
		if err != nil {
			t.Fatal(err)
		}
		snapshot, err := state.policySnapshotBytes()
		if err != nil {
			t.Fatal(err)
		}
		draft.TextProjectionRoot, draft.ResultDigest = tree.root(), hexHash(snapshot)
		draft.Signature = ed25519.Sign(signer, []byte(draft.OperationID))
		proof := PolicyProof{Principal: actor, Draft: draft, Digest: hexHash(draft.Signature)}
		raw, err := json.Marshal(proof)
		if err != nil {
			t.Fatal(err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_policy_proofs(revision,operation_id,digest,snapshot,record)
			VALUES(?,?,?,?,?)`, draft.Revision, draft.OperationID, proof.Digest, snapshot, raw); err != nil {
			t.Fatal(err)
		}
		if draft.Action == RedeemPolicyInvite {
			if err := storeScopedInviteReceipt(ctx, tx, proof, func(_ context.Context, _ SessionQuery, receipt ScopedInviteReceipt) ([]byte, error) {
				frame, err := ScopedInviteReceiptFrame(serverID, receipt)
				if err != nil {
					return nil, err
				}
				return ed25519.Sign(serverKey, frame), nil
			}); err != nil {
				t.Fatal(err)
			}
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return proof
	}
	base := persist(owner, PolicyDraft{Action: AnchorPolicy, Revision: 1, OperationID: strings.Repeat("a", 32)})
	attest := func(proof PolicyProof) {
		t.Helper()
		view := PolicyAttestation{Revision: proof.Draft.Revision, ProjectionVersion: version, Digest: proof.Digest,
			Previous: proof.Draft.PreviousDigest, PolicyDigest: proof.Draft.ResultDigest, Root: proof.Draft.TextProjectionRoot}
		frame, err := PolicyAttestationFrame(serverID, base.Digest, owner, view)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, "INSERT INTO protected_policy_attestations(revision,signature) VALUES(?,?)", view.Revision, ed25519.Sign(signer, frame)); err != nil {
			t.Fatal(err)
		}
	}
	attest(base)
	baseState := state
	state.Members = maps.Clone(state.Members)
	state.PolicyDevices = maps.Clone(state.PolicyDevices)
	state.KeyRecipients = maps.Clone(state.KeyRecipients)
	state.Channels = maps.Clone(state.Channels)
	state.InvitationUses = maps.Clone(state.InvitationUses)
	issue := InviteIssuance{Issuer: owner, PolicyRevision: 1, PolicyDigest: base.Digest,
		CreatedAt: 1, AcceptedAt: 2, ExpiresAt: 100, MaxUses: 3, Signature: state.InvitationUses[inviteID].IssueSignature}
	successor := base
	var first PolicyProof
	for index, position := range []uint64{8, 11} {
		revision := int64(index + 2)
		device := parseScopeAuthorityKey(scopeAuthorityTestPublicKey(scopeAuthorityTestKey(byte(94 + index))))
		profile := parseScopeAuthorityKey(scopeAuthorityTestPublicKey(scopeAuthorityTestKey(byte(96 + index))))
		actor := Principal{ProfileID: hexHash(profile), DeviceID: hexHash(device)}
		operation := fmt.Sprintf("%032x", revision)
		admission := InvitePolicyAdmission{CutoverDigest: strings.Repeat("d", 64), ServerKey: base64.RawURLEncoding.EncodeToString(serverPublic),
			Issuance: &issue, Claim: InviteRedeem{InviteID: inviteID, OperationID: operation,
				ProfilePublicKey: base64.RawURLEncoding.EncodeToString(profile), DevicePublicKey: base64.RawURLEncoding.EncodeToString(device),
				AgreementKey: recoveryTestAgreementKey(t, byte(94+index))}}
		change := PolicyResourceChange{ID: actor.ProfileID, Admission: &admission}
		room := state.Channels[channel]
		room.NextPosition = position
		state.Channels[channel] = room
		if err := state.admitInviteMember(actor, change, true); err != nil {
			t.Fatal(err)
		}
		successor = persist(actor, PolicyDraft{Action: RedeemPolicyInvite, Revision: revision, OperationID: operation,
			PreviousDigest: successor.Digest, ResourceChange: &change})
		if index == 0 {
			first = successor
		}
	}
	task := RotationTask{EpochRecord: EpochRecord{ChannelID: channel, Purpose: LiveEpoch, Revision: successor.Draft.Revision,
		PolicyDigest: successor.Draft.ResultDigest}, Recipients: maps.Clone(state.KeyRecipients)}
	var cache textChannelPolicyTreeCache
	build := func(task RotationTask) *InviteAdmissionBatchEvidence {
		t.Helper()
		proof, err := buildInviteAdmissionBatch(ctx, db, state, baseState, base, successor, task, owner, &cache)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	witness := build(task)
	if witness == nil || len(witness.Admissions) != 2 || len(witness.PreviousOpenings) != 1 || witness.Newcomer.Archive != fullHistory {
		t.Fatalf("missing exact two-admission proof: %+v", witness)
	}
	for i, child := range witness.Admissions {
		if child.NewcomerTextPolicy.Recipient.Statement.FirstPosition != uint64(8+i*3) ||
			child.NewcomerTextPolicy.Revision != int64(i+2) || child.Freshness.Use.Count != 1 ||
			child.IssuerAuthority.Opening.SigningKey != signerKey {
			t.Fatalf("child %d did not preserve its own root and the common base use: %+v", i, child)
		}
	}
	raw, err := json.Marshal(witness)
	if err != nil || strings.Contains(string(raw), "TextProjectionSeed") || strings.Contains(string(raw), "InvitationUses") {
		t.Fatalf("batch exposed private policy fields: %v", err)
	}
	firstReceipt, secondReceipt := *witness.Admissions[0].Draft, *witness.Admissions[1].Draft
	for _, change := range []func(*ScopedInviteReceipt){
		func(receipt *ScopedInviteReceipt) { receipt.Actor.ProfileID = firstReceipt.Actor.ProfileID },
		func(receipt *ScopedInviteReceipt) { receipt.Actor.DeviceID = firstReceipt.Actor.DeviceID },
		func(receipt *ScopedInviteReceipt) {
			receipt.Admission.Claim.AgreementKey = firstReceipt.Admission.Claim.AgreementKey
		},
	} {
		changed := secondReceipt
		change(&changed)
		if matchesInviteBatchRoster(baseState.KeyRecipients, task.Recipients, []ScopedInviteReceipt{firstReceipt, changed}) {
			t.Fatal("batch accepted a reused applicant credential")
		}
	}
	liveDigest, err := inviteAdmissionBatchDigest(task.EpochRecord, *witness)
	if err != nil {
		t.Fatal(err)
	}
	live := task.EpochRecord
	live.Generation, live.KeyID, live.TaskID = 2, strings.Repeat("8", 64), strings.Repeat("8", 32)
	live.LiveTransitionDigest = liveDigest
	live.Signature = ed25519.Sign(signer, []byte(liveDigest))
	verify := func(_ context.Context, _ SessionQuery, actor Principal, record EpochRecord) error {
		if actor != owner || !ed25519.Verify(signer.Public().(ed25519.PublicKey), []byte(record.LiveTransitionDigest), record.Signature) {
			return ErrEpochConflict
		}
		return nil
	}
	var committedBase int64
	if err := checkEpochTransition(ctx, db, state, owner, live, task.Recipients, verify, &committedBase); err != nil || committedBase != 1 {
		t.Fatalf("epoch commit did not pin the exact batch base: %d %v", committedBase, err)
	}
	raw, err = json.Marshal(storedEpochProof{Principal: owner, Record: live, InviteAdmissionBaseRevision: committedBase})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO protected_epochs(channel_id,purpose,generation,key_id,task_id,digest,record)
		VALUES(?,?,?,?,?,?,?)`, channel, LiveEpoch, live.Generation, live.KeyID, live.TaskID, hexHash(live.Signature), raw); err != nil {
		t.Fatal(err)
	}
	state.EpochWindows = map[string]EpochWindow{channel: {Current: live.Generation}}
	archive := task
	archive.Purpose = ArchiveEpoch
	archive.ArchiveThrough = live.Generation
	archiveWitness := build(archive)
	if fullHistory {
		if archiveWitness == nil || archiveWitness.PreviousOpenings[owner.ProfileID] == witness.PreviousOpenings[owner.ProfileID] {
			t.Fatal("archive witness did not use archive-purpose group openings")
		}
		archiveDigest, err := inviteAdmissionBatchDigest(archive.EpochRecord, *archiveWitness)
		if err != nil || archiveDigest == liveDigest {
			t.Fatalf("batch marker purpose separation: %s / %s, %v", liveDigest, archiveDigest, err)
		}
	} else if archiveWitness != nil {
		t.Fatal("limited newcomers received archive rotation evidence")
	}
	changed := task
	changed.Recipients = maps.Clone(task.Recipients)
	delete(changed.Recipients, owner.DeviceID)
	changed.Recipients[strings.Repeat("7", 64)] = task.Recipients[owner.DeviceID]
	if build(changed) != nil {
		t.Fatal("changed survivor roster got a batch proof")
	}
	uses := maps.Clone(state.InvitationUses)
	if advanceInviteBatchUse(uses, witness.Admissions[0].Draft.Admission) {
		t.Fatal("batch accepted one more use of the shared invitation than authorized")
	}
	attest(first)
	if build(task) != nil {
		t.Fatal("batch proof crossed a later independently attested base")
	}
	stored, err := readEpoch(ctx, db, channel, LiveEpoch, live.KeyID)
	if err != nil || stored.inviteAdmissionBaseRevision != 1 {
		t.Fatalf("immutable epoch lost its batch base: %+v, %v", stored, err)
	}
	receiptViewer := witness.Admissions[1].Draft.Actor
	opened, err := inviteAdmissionBatchPackageEvidence(ctx, db, state, state, successor, stored, receiptViewer, &cache)
	if err != nil || opened == nil || opened.PreviousTextPolicy != nil ||
		opened.Admissions[1].NewcomerTextPolicy.Recipient.Statement.FirstPosition != 11 {
		t.Fatalf("historical batch lost addressed newcomer floor after attestation: %+v, %v", opened, err)
	}
	retained, err := inviteAdmissionBatchPackageEvidence(ctx, db, state, state, successor, stored, owner, &cache)
	if err != nil || retained == nil || retained.PreviousTextPolicy == nil {
		t.Fatalf("historical batch lost the retained viewer’s base disclosure: %+v, %v", retained, err)
	}
	authors, err := readLiveMessageAuthorBasis(ctx, db, channel, live.KeyID, &cache, verify)
	if err != nil || authors.newcomers[witness.Admissions[0].Draft.Actor] != 8 || authors.newcomers[receiptViewer] != 11 {
		t.Fatalf("historical author proof lost individual floors: %+v, %v", authors, err)
	}
	prior, err := authors.previousAuthorDisclosure(owner, &cache)
	if err != nil || prior == nil || prior.Recipient == nil {
		t.Fatalf("retained author lost its base signing proof: %+v, %v", prior, err)
	}
	if fullHistory {
		active, err := readCurrentInviteAdmissionBatch(ctx, db, state, successor, archive, owner, &cache, verify)
		if err != nil || active == nil || active.PreviousRevision != 1 {
			t.Fatalf("archive did not continue its committed LIVE prefix: %+v, %v", active, err)
		}
	}
}
