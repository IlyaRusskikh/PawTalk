package access

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"maps"
	"strconv"
)

type InviteAdmissionRotationEvidence struct {
	PreviousRevision   int64                             `json:"previousRevision"`
	PreviousHead       string                            `json:"previousHead"`
	SuccessorHead      string                            `json:"successorHead"`
	Draft              *ScopedInviteReceipt              `json:"draft"`
	PreviousTextPolicy *TextChannelPolicyDisclosure      `json:"previousTextPolicy"`
	Newcomer           TextNewcomerAdmissionOpening      `json:"newcomer"`
	NewcomerTextPolicy *TextChannelPolicyDisclosure      `json:"newcomerTextPolicy"`
	PreviousOpenings   map[string]RotationProfileOpening `json:"previousOpenings"`
	IssuerAuthority    InviteAdmissionIssuerAuthority    `json:"issuerAuthority"`
	Freshness          InviteAdmissionFreshness          `json:"freshness"`
}

type InviteAdmissionIssuerAuthority struct {
	InviteAdmissionScopeOpening
	Opening *InviteIssuerProof `json:"opening"`
}

type InviteAdmissionFreshness struct {
	InviteAdmissionScopeOpening
	Profile   []InviteCredentialSibling `json:"profile"`
	Device    []InviteCredentialSibling `json:"device"`
	Agreement []InviteCredentialSibling `json:"agreement"`
	Use       InviteUseOpening          `json:"use"`
}

type inviteAdmissionRotationBasis struct {
	previous    State
	predecessor PolicyProof
	rotation    *InviteAdmissionRotationEvidence
}

func inviteAdmissionTransitionDigest(record EpochRecord, evidence InviteAdmissionRotationEvidence) (string, error) {
	if (record.Purpose != LiveEpoch && record.Purpose != ArchiveEpoch) || evidence.Draft == nil {
		return "", InvalidAction
	}
	frame, err := SignatureFrame("pawtalk-protected-"+record.Purpose+"-invite-admission-v1", record.ChannelID,
		strconv.FormatInt(evidence.PreviousRevision, 10), evidence.PreviousHead, strconv.FormatInt(record.Revision, 10),
		evidence.SuccessorHead, record.PolicyDigest, evidence.Draft.OperationID, evidence.Draft.Actor.ProfileID,
		evidence.Draft.Actor.DeviceID, base64.StdEncoding.EncodeToString(evidence.Draft.Signature))
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func inviteAdmissionRotationEvidence(ctx context.Context, query SessionQuery, current State, head PolicyProof, task RotationTask,
	claimant Principal, historical *textChannelPolicyTreeCache, verify VerifyEpochRecord) (*InviteAdmissionRotationEvidence, error) {
	basis, err := readInviteAdmissionRotationBasis(ctx, query, current, head, task, claimant, historical)
	if err != nil || basis == nil {
		return nil, err
	}
	if task.Purpose == ArchiveEpoch {
		valid, err := archiveInviteLiveSource(ctx, query, current, task.EpochRecord, *basis.rotation, verify)
		if err != nil || !valid {
			return nil, err
		}
	}
	return basis.rotation, nil
}

func archiveInviteLiveSource(ctx context.Context, query SessionQuery, current State, archive EpochRecord,
	evidence InviteAdmissionRotationEvidence, verify VerifyEpochRecord) (bool, error) {
	return matchingInviteLiveSource(ctx, query, current, archive, verify, func(live EpochRecord) (string, error) {
		return inviteAdmissionTransitionDigest(live, evidence)
	})
}

func matchingInviteLiveSource(ctx context.Context, query SessionQuery, current State, archive EpochRecord, verify VerifyEpochRecord,
	marker func(EpochRecord) (string, error)) (bool, error) {
	live, err := currentInviteLiveSource(ctx, query, current, archive)
	if err != nil || live == nil {
		return false, err
	}
	record := live.Record
	expected, err := marker(record)
	if err != nil || record.LiveTransitionDigest != expected {
		return false, err
	}
	if verify != nil {
		if err := verify(ctx, query, live.Principal, record); err != nil {
			return false, err
		}
	}
	return true, nil
}

func currentInviteLiveSource(ctx context.Context, query SessionQuery, current State, archive EpochRecord) (*EpochProof, error) {
	generation := current.currentGeneration(archive.ChannelID, LiveEpoch)
	if archive.ArchiveThrough == 0 || archive.ArchiveThrough > generation {
		return nil, nil
	}
	var key string
	if err := query.QueryRowContext(ctx, `SELECT key_id FROM protected_epochs
		WHERE channel_id=? AND purpose=? AND generation=?`, archive.ChannelID, LiveEpoch, generation).Scan(&key); err != nil {
		return nil, err
	}
	live, err := readEpoch(ctx, query, archive.ChannelID, LiveEpoch, key)
	if err != nil {
		return nil, err
	}
	record := live.Record
	if record.Generation != generation || record.Revision != archive.Revision || record.PolicyDigest != archive.PolicyDigest ||
		record.LiveTransitionDigest == "" {
		return nil, nil
	}
	return &live, nil
}

func readInviteAdmissionRotationBasis(ctx context.Context, query SessionQuery, current State, head PolicyProof, task RotationTask,
	claimant Principal, historical *textChannelPolicyTreeCache) (*inviteAdmissionRotationBasis, error) {
	change := head.Draft.ResourceChange
	if (task.Purpose != LiveEpoch && task.Purpose != ArchiveEpoch) || head.Draft.Action != RedeemPolicyInvite ||
		!supportsScopedInviteReceipts(head.Draft.TextProjectionVersion) ||
		task.Revision != head.Draft.Revision || task.PolicyDigest != head.Draft.ResultDigest ||
		change == nil || change.Admission == nil || change.Admission.Issuance == nil {
		return nil, nil
	}
	issue := change.Admission.Issuance
	if issue.PolicyRevision <= 0 || issue.PolicyRevision >= head.Draft.Revision {
		return nil, nil
	}
	previous, predecessor, err := readPrecedingPolicyState(ctx, query, head.Draft)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	issuerState, issuerHead := previous, predecessor
	if issue.PolicyRevision != predecessor.Draft.Revision {
		issuerHead, err = readAttestedProof(ctx, query, issue.PolicyRevision)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		issuerState, _, err = readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy_proofs WHERE revision=?",
			issue.PolicyRevision))
		if err != nil {
			return nil, err
		}
		issuerState.PolicyAnchored = true
		if err := checkPolicyHead(issuerState, issue.PolicyRevision, issuerHead); err != nil {
			return nil, err
		}
	}
	revisions := []int64{predecessor.Draft.Revision}
	if issuerHead.Draft.Revision != predecessor.Draft.Revision {
		revisions = append(revisions, issuerHead.Draft.Revision)
	}
	for _, revision := range revisions {
		var attested bool
		if err := query.QueryRowContext(ctx, `SELECT EXISTS(
			SELECT 1 FROM protected_policy_attestations WHERE revision=?
			UNION ALL SELECT 1 FROM protected_policy_attestations_v2 WHERE revision=?
		)`, revision, revision).Scan(&attested); err != nil || !attested {
			return nil, err
		}
	}
	receipt, err := ReadScopedInviteReceipt(ctx, query, head.Digest)
	if err != nil || receipt == nil {
		return nil, err
	}
	rotation, err := buildInviteAdmissionRotationEvidence(previous, current, issuerState, predecessor, head, issuerHead, task, claimant, receipt, historical)
	if err != nil || rotation == nil {
		return nil, err
	}
	return &inviteAdmissionRotationBasis{previous: previous, predecessor: predecessor, rotation: rotation}, nil
}

func buildInviteAdmissionRotationEvidence(previous, current, issuerState State, predecessor, head, issuerHead PolicyProof,
	task RotationTask, claimant Principal, receipt *ScopedInviteReceipt, historical *textChannelPolicyTreeCache) (*InviteAdmissionRotationEvidence, error) {
	admission := head.Draft.ResourceChange.Admission
	issue := admission.Issuance
	version := predecessor.Draft.TextProjectionVersion
	issuerVersion := issuerHead.Draft.TextProjectionVersion
	if !supportsScopedInviteReceipts(version) || head.Draft.TextProjectionVersion != version ||
		!supportsScopedInviteReceipts(issuerVersion) || issuerVersion > version || head.Draft.PreviousDigest != predecessor.Digest ||
		issuerHead.Digest != issue.PolicyDigest || issuerHead.Draft.Revision != issue.PolicyRevision ||
		receipt.Revision != head.Draft.Revision || receipt.PreviousDigest != predecessor.Digest ||
		receipt.ResultDigest != head.Draft.ResultDigest || receipt.ProjectionRoot != head.Draft.TextProjectionRoot || receipt.Digest != head.Digest ||
		receipt.OperationID != head.Draft.OperationID || receipt.Actor != head.Principal || len(receipt.Signature) != ed25519.SignatureSize ||
		receipt.Admission.Claim != admission.Claim || receipt.Admission.CutoverDigest != admission.CutoverDigest ||
		receipt.Admission.ServerKey != admission.ServerKey || receipt.Admission.Issuance == nil || *receipt.Admission.Issuance != *issue {
		return nil, nil
	}
	var seed, issuerSeed [32]byte
	if _, err := hex.Decode(seed[:], []byte(predecessor.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	if _, err := hex.Decode(issuerSeed[:], []byte(issuerHead.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	channel := task.ChannelID
	commitment, newcomer, err := previous.textNewcomerAdmissionCommitment(channel, seed)
	if err != nil {
		return nil, err
	}
	oldRecipients, err := inviteAdmissionAudience(previous, current, task, claimant, head.Principal, admission.Claim, newcomer)
	if err != nil || oldRecipients == nil {
		return nil, err
	}
	oldUse := previous.InvitationUses[admission.Claim.InviteID]
	newUse := current.InvitationUses[admission.Claim.InviteID]
	if oldUse.Count >= maxInviteUseLimit || issue.MaxUses != 0 && oldUse.Count >= issue.MaxUses ||
		oldUse.Count > 0 && oldUse.IssueSignature != issue.Signature ||
		newUse != (InvitePolicyUse{IssueSignature: issue.Signature, Count: oldUse.Count + 1}) {
		return nil, nil
	}
	issuerScope, err := inviteAdmissionAttestedScope(issuerState, issuerHead, historical)
	if err != nil {
		return nil, err
	}
	issuers, issuer, err := issuerState.inviteIssuerCommitment(issuerSeed, issue.Issuer)
	if err != nil || issuer == nil {
		return nil, err
	}
	if issuers != issuerScope.Issuers {
		return nil, ErrPolicyConflict
	}
	freshScope, err := inviteAdmissionAttestedScope(previous, predecessor, historical)
	if err != nil {
		return nil, err
	}
	freshness, err := inviteAdmissionFreshness(previous, freshScope, head.Principal, admission.Claim)
	if errors.Is(err, ErrInviteConflict) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	text, err := textChannelDisclosure(previous, predecessor, channel, claimant.DeviceID, historical, 0)
	if err != nil {
		return nil, err
	}
	if text == nil || text.Recipient == nil || text.Rotation == nil || text.Rotation.Newcomer != commitment {
		return nil, ErrPolicyConflict
	}
	entrant, err := textChannelDisclosure(current, head, channel, head.Principal.DeviceID, historical, 0)
	if err != nil {
		return nil, err
	}
	if entrant == nil || entrant.Recipient == nil ||
		entrant.Recipient.Statement.FirstPosition != current.Admissions[channel][head.Principal.ProfileID].FirstPosition {
		return nil, ErrPolicyConflict
	}
	return &InviteAdmissionRotationEvidence{
		PreviousRevision: predecessor.Draft.Revision, PreviousHead: predecessor.Digest, SuccessorHead: head.Digest,
		Draft: receipt, PreviousTextPolicy: text, Newcomer: newcomer, NewcomerTextPolicy: entrant,
		PreviousOpenings: rotationProfileOpenings(oldRecipients, seed, channel, task.Purpose),
		IssuerAuthority:  InviteAdmissionIssuerAuthority{InviteAdmissionScopeOpening: issuerScope, Opening: issuer},
		Freshness:        freshness,
	}, nil
}

func inviteAdmissionAttestedScope(state State, proof PolicyProof, cache *textChannelPolicyTreeCache) (InviteAdmissionScopeOpening, error) {
	tree, err := cache.treeFor(state, proof)
	if err != nil {
		return InviteAdmissionScopeOpening{}, err
	}
	opening := tree.inviteAdmission
	opening.Inclusion, err = tree.proof(profileRankProjectionID)
	return opening, err
}

func inviteAdmissionFreshness(previous State, scope InviteAdmissionScopeOpening, actor Principal, claim InviteRedeem) (InviteAdmissionFreshness, error) {
	requests := make(map[inviteCredential]bool, 4)
	addInviteAdmissionFreshnessRequests(requests, actor, claim)
	root, paths, err := previous.inviteCredentialOpenings(requests)
	if err != nil {
		return InviteAdmissionFreshness{}, err
	}
	if root != scope.Credentials {
		return InviteAdmissionFreshness{}, ErrPolicyConflict
	}
	return assembleInviteAdmissionFreshness(previous, scope, actor, claim, paths), nil
}

func addInviteAdmissionFreshnessRequests(requests map[inviteCredential]bool, actor Principal, claim InviteRedeem) {
	requests[inviteCredential{"profile", actor.ProfileID}] = true
	requests[inviteCredential{"device", actor.DeviceID}] = true
	requests[inviteCredential{"agreement", claim.AgreementKey}] = true
	requests[inviteCredential{"invite-use", claim.InviteID}] = false
}

func assembleInviteAdmissionFreshness(previous State, scope InviteAdmissionScopeOpening, actor Principal, claim InviteRedeem,
	paths map[inviteCredential][]InviteCredentialSibling) InviteAdmissionFreshness {
	use := previous.InvitationUses[claim.InviteID]
	return InviteAdmissionFreshness{
		InviteAdmissionScopeOpening: scope,
		Profile:                     paths[inviteCredential{"profile", actor.ProfileID}],
		Device:                      paths[inviteCredential{"device", actor.DeviceID}],
		Agreement:                   paths[inviteCredential{"agreement", claim.AgreementKey}],
		Use:                         InviteUseOpening{Count: use.Count, IssueSignature: use.IssueSignature, Path: paths[inviteCredential{"invite-use", claim.InviteID}]},
	}
}

func inviteAdmissionAudience(previous, current State, task RotationTask, claimant, entrant Principal, claim InviteRedeem,
	newcomer TextNewcomerAdmissionOpening) (map[string]KeyRecipient, error) {
	channel, purpose := task.ChannelID, task.Purpose
	if (purpose != LiveEpoch && purpose != ArchiveEpoch) || !newcomer.Visible || (purpose == ArchiveEpoch && !newcomer.Archive) ||
		claimant.ProfileID == entrant.ProfileID ||
		!retainedPersonalDenyReader(previous, current, task.EpochRecord, claimant) ||
		!current.hasPolicyDevice(entrant) || !current.canLoadEpoch(entrant, channel, purpose) ||
		current.canLoadEpoch(entrant, channel, ArchiveEpoch) != newcomer.Archive ||
		current.Admissions[channel][entrant.ProfileID].FirstPosition == 0 {
		return nil, nil
	}
	subject := current.Members[entrant.ProfileID]
	if len(subject.Roles) != 0 || (current.CheckGrant(subject, current.scope(current.Channels[channel]), "message.send", 0) == Allowed) != newcomer.CanSend {
		return nil, nil
	}
	profileKey, profileOK := inviteClaimKey(claim.ProfilePublicKey)
	deviceKey, deviceOK := inviteClaimKey(claim.DevicePublicKey)
	if !profileOK || !deviceOK || hexHash(profileKey) != entrant.ProfileID || hexHash(deviceKey) != entrant.DeviceID ||
		!signingKeyMatches(entrant.DeviceID, current.PolicyDevices[entrant.DeviceID].PublicKey) {
		return nil, nil
	}
	oldRecipients, err := previous.rotationRecipients(channel, purpose)
	if err != nil {
		return nil, err
	}
	freshRecipient := KeyRecipient{ProfileID: entrant.ProfileID, Kind: "device", PublicKey: claim.AgreementKey}
	if task.Recipients[entrant.DeviceID] != freshRecipient || current.KeyRecipients[entrant.DeviceID] != freshRecipient ||
		len(task.Recipients) != len(oldRecipients)+1 {
		return nil, nil
	}
	for id, recipient := range oldRecipients {
		if recipient.ProfileID == entrant.ProfileID || task.Recipients[id] != recipient {
			return nil, nil
		}
	}
	if !newcomer.Archive {
		// A limited newcomer cannot change the existing archive audience.
		oldArchive, oldErr := previous.rotationRecipients(channel, ArchiveEpoch)
		newArchive, newErr := current.rotationRecipients(channel, ArchiveEpoch)
		if (oldErr != nil || newErr != nil) && (!errors.Is(oldErr, ErrEpochRecipients) || !errors.Is(newErr, ErrEpochRecipients)) {
			return nil, nil
		}
		if !maps.Equal(oldArchive, newArchive) {
			return nil, nil
		}
	}
	return oldRecipients, nil
}
