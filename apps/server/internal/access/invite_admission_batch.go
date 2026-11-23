package access

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"maps"
)

type InviteAdmissionBatchEvidence struct {
	PreviousRevision   int64                             `json:"previousRevision"`
	PreviousHead       string                            `json:"previousHead"`
	SuccessorHead      string                            `json:"successorHead"`
	Newcomer           TextNewcomerAdmissionOpening      `json:"newcomer"`
	PreviousTextPolicy *TextChannelPolicyDisclosure      `json:"previousTextPolicy"`
	PreviousOpenings   map[string]RotationProfileOpening `json:"previousOpenings"`
	Admissions         []InviteAdmissionBatchItem        `json:"admissions"`
}

type InviteAdmissionBatchItem struct {
	Draft              *ScopedInviteReceipt           `json:"draft"`
	NewcomerTextPolicy *TextChannelPolicyDisclosure   `json:"newcomerTextPolicy"`
	IssuerAuthority    InviteAdmissionIssuerAuthority `json:"issuerAuthority"`
	Freshness          InviteAdmissionFreshness       `json:"freshness"`
}

// buildInviteAdmissionBatch requires the locked current policy, its latest
// attested base, and a pinned task with the current recipients for one purpose.
// Each child opens only its own first admission under its signed receipt.
func buildInviteAdmissionBatch(ctx context.Context, query SessionQuery, current, baseState State, base, successor PolicyProof,
	task RotationTask, claimant Principal, cache *textChannelPolicyTreeCache) (*InviteAdmissionBatchEvidence, error) {
	return buildInviteAdmissionBatchAt(ctx, query, current, baseState, base, successor, task, claimant, cache, true)
}

func buildInviteAdmissionBatchAt(ctx context.Context, query SessionQuery, current, baseState State, base, successor PolicyProof,
	task RotationTask, claimant Principal, cache *textChannelPolicyTreeCache, latest bool) (*InviteAdmissionBatchEvidence, error) {
	version := base.Draft.TextProjectionVersion
	if !supportsScopedInviteReceipts(version) || successor.Draft.TextProjectionVersion != version ||
		successor.Draft.Revision-base.Draft.Revision < 2 || successor.Draft.Action != RedeemPolicyInvite ||
		task.Revision != successor.Draft.Revision || task.PolicyDigest != successor.Draft.ResultDigest ||
		(task.Purpose != LiveEpoch && task.Purpose != ArchiveEpoch) ||
		!retainedPersonalDenyReader(baseState, current, task.EpochRecord, claimant) {
		return nil, nil
	}
	if err := checkPolicyHead(baseState, base.Draft.Revision, base); err != nil {
		return nil, err
	}
	if err := checkPolicyHead(current, successor.Draft.Revision, successor); err != nil {
		return nil, err
	}
	attested, err := inviteBatchHasAttestation(ctx, query, base.Draft.Revision)
	if err != nil || !attested {
		return nil, err
	}
	if latest {
		var laterBase bool
		if err := query.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM protected_policy_attestations WHERE revision>? AND revision<?
		UNION ALL SELECT 1 FROM protected_policy_attestations_v2 WHERE revision>? AND revision<?
		)`, base.Draft.Revision, successor.Draft.Revision, base.Draft.Revision, successor.Draft.Revision).Scan(&laterBase); err != nil || laterBase {
			return nil, err
		}
	}
	oldRecipients, err := baseState.rotationRecipients(task.ChannelID, task.Purpose)
	if err != nil {
		return nil, err
	}
	additions := len(task.Recipients) - len(oldRecipients)
	if additions < 2 || len(task.Recipients) > maxInviteAdmissionBatch || int64(additions) != successor.Draft.Revision-base.Draft.Revision {
		return nil, nil
	}
	currentRecipients, err := current.rotationRecipients(task.ChannelID, task.Purpose)
	if err != nil || !maps.Equal(currentRecipients, task.Recipients) {
		return nil, err
	}
	receipts, err := ReadScopedInviteReceiptChain(ctx, query, base, successor)
	if err != nil || receipts == nil {
		return nil, err
	}
	if len(receipts) != additions {
		return nil, ErrPolicyConflict
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(base.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	channel := task.ChannelID
	commitment, newcomer, err := baseState.textNewcomerAdmissionCommitment(channel, seed)
	if err != nil || !newcomer.Visible || task.Purpose == ArchiveEpoch && !newcomer.Archive {
		return nil, err
	}
	if !matchesInviteBatchRoster(oldRecipients, task.Recipients, receipts) {
		return nil, nil
	}
	if !newcomer.Archive {
		oldArchive, oldErr := baseState.rotationRecipients(channel, ArchiveEpoch)
		newArchive, newErr := current.rotationRecipients(channel, ArchiveEpoch)
		if (oldErr != nil || newErr != nil) && (!errors.Is(oldErr, ErrEpochRecipients) || !errors.Is(newErr, ErrEpochRecipients)) ||
			!maps.Equal(oldArchive, newArchive) {
			return nil, nil
		}
	}
	freshnessScope, err := inviteAdmissionAttestedScope(baseState, base, cache)
	if err != nil {
		return nil, err
	}
	freshnessRequests := make(map[inviteCredential]bool, len(receipts)*4)
	for _, receipt := range receipts {
		addInviteAdmissionFreshnessRequests(freshnessRequests, receipt.Actor, receipt.Admission.Claim)
	}
	freshnessRoot, freshnessPaths, err := baseState.inviteCredentialOpenings(freshnessRequests)
	if errors.Is(err, ErrInviteConflict) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if freshnessRoot != freshnessScope.Credentials {
		return nil, ErrPolicyConflict
	}
	text, err := textChannelDisclosure(baseState, base, channel, claimant.DeviceID, cache, 0)
	if err != nil {
		return nil, err
	}
	if text == nil || text.Recipient == nil || text.Rotation == nil || text.Rotation.Newcomer != commitment {
		return nil, ErrPolicyConflict
	}
	result := &InviteAdmissionBatchEvidence{
		PreviousRevision: base.Draft.Revision, PreviousHead: base.Digest, SuccessorHead: successor.Digest,
		Newcomer: newcomer, PreviousTextPolicy: text,
		PreviousOpenings: rotationProfileOpenings(oldRecipients, seed, channel, task.Purpose),
		Admissions:       make([]InviteAdmissionBatchItem, 0, len(receipts)),
	}
	uses := make(map[string]InvitePolicyUse, len(baseState.InvitationUses)+len(receipts))
	maps.Copy(uses, baseState.InvitationUses)
	type issuanceKey struct {
		revision int64
		digest   string
		issuer   Principal
	}
	authorities := make(map[issuanceKey]*InviteAdmissionIssuerAuthority)
	for i := range receipts {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		receipt := &receipts[i]
		if !advanceInviteBatchUse(uses, receipt.Admission) {
			return nil, nil
		}
		child := current
		childHead := successor
		if receipt.Revision != successor.Draft.Revision {
			child, childHead, err = readInviteBatchPolicy(ctx, query, receipt.Revision)
			if err != nil {
				return nil, err
			}
		}
		if receipt.Digest != childHead.Digest || receipt.ResultDigest != childHead.Draft.ResultDigest ||
			receipt.ProjectionRoot != childHead.Draft.TextProjectionRoot || !maps.Equal(child.InvitationUses, uses) {
			return nil, ErrPolicyConflict
		}
		if !supportsInviteBatchNewcomer(child, current, task.EpochRecord, receipt, newcomer) {
			return nil, nil
		}
		issue := receipt.Admission.Issuance
		key := issuanceKey{revision: issue.PolicyRevision, digest: issue.PolicyDigest, issuer: issue.Issuer}
		authority := authorities[key]
		if authority == nil {
			authority, err = inviteBatchIssuerAuthority(ctx, query, baseState, base, issue, cache)
			if err != nil || authority == nil {
				return nil, err
			}
			authorities[key] = authority
		}
		proof, err := textChannelDisclosure(child, childHead, channel, receipt.Actor.DeviceID, cache, 0)
		if err != nil {
			return nil, err
		}
		if proof == nil || proof.Recipient == nil ||
			proof.Recipient.Statement.FirstPosition != child.Admissions[channel][receipt.Actor.ProfileID].FirstPosition {
			return nil, ErrPolicyConflict
		}
		result.Admissions = append(result.Admissions, InviteAdmissionBatchItem{
			Draft: receipt, NewcomerTextPolicy: proof, IssuerAuthority: *authority,
			Freshness: assembleInviteAdmissionFreshness(baseState, freshnessScope, receipt.Actor, receipt.Admission.Claim, freshnessPaths),
		})
	}
	return result, nil
}

func readCurrentInviteAdmissionBatch(ctx context.Context, query SessionQuery, current State, head PolicyProof,
	task RotationTask, claimant Principal, cache *textChannelPolicyTreeCache, verify VerifyEpochRecord) (*InviteAdmissionBatchEvidence, error) {
	if head.Draft.Action != RedeemPolicyInvite || !supportsScopedInviteReceipts(head.Draft.TextProjectionVersion) {
		return nil, nil
	}
	var baseRevision sql.NullInt64
	if task.Purpose == ArchiveEpoch {
		live, err := currentInviteLiveSource(ctx, query, current, task.EpochRecord)
		if err != nil || live == nil || live.inviteAdmissionBaseRevision == 0 {
			return nil, err
		}
		baseRevision = sql.NullInt64{Int64: live.inviteAdmissionBaseRevision, Valid: true}
	} else if err := query.QueryRowContext(ctx, `SELECT MAX(revision) FROM (
		SELECT revision FROM protected_policy_attestations WHERE revision<?
		UNION ALL SELECT revision FROM protected_policy_attestations_v2 WHERE revision<?
	)`, head.Draft.Revision, head.Draft.Revision).Scan(&baseRevision); err != nil {
		return nil, err
	}
	if !baseRevision.Valid || head.Draft.Revision-baseRevision.Int64 < 2 {
		return nil, nil
	}
	previous, base, err := readInviteBatchPolicy(ctx, query, baseRevision.Int64)
	if err != nil {
		return nil, err
	}
	batch, err := buildInviteAdmissionBatchAt(ctx, query, current, previous, base, head, task, claimant, cache, task.Purpose != ArchiveEpoch)
	if err != nil || batch == nil {
		return nil, err
	}
	if task.Purpose == ArchiveEpoch {
		valid, err := matchingInviteLiveSource(ctx, query, current, task.EpochRecord, verify, func(live EpochRecord) (string, error) {
			return inviteAdmissionBatchDigest(live, *batch)
		})
		if err != nil || !valid {
			return nil, err
		}
	}
	return batch, nil
}

func matchesInviteBatchRoster(old, actual map[string]KeyRecipient, receipts []ScopedInviteReceipt) bool {
	if len(old)+len(receipts) != len(actual) {
		return false
	}
	profiles := make(map[string]bool, len(old)+len(receipts))
	devices := make(map[string]bool, len(old)+len(receipts))
	agreements := make(map[string]bool, len(old)+len(receipts))
	for id, recipient := range old {
		if actual[id] != recipient {
			return false
		}
		profiles[recipient.ProfileID], devices[id], agreements[recipient.PublicKey] = true, true, true
	}
	for _, receipt := range receipts {
		actor, key := receipt.Actor, receipt.Admission.Claim.AgreementKey
		if profiles[actor.ProfileID] || devices[actor.DeviceID] || agreements[key] ||
			actual[actor.DeviceID] != (KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: key}) {
			return false
		}
		profiles[actor.ProfileID], devices[actor.DeviceID], agreements[key] = true, true, true
	}
	return true
}

func advanceInviteBatchUse(uses map[string]InvitePolicyUse, admission InvitePolicyAdmission) bool {
	id, issue := admission.Claim.InviteID, admission.Issuance
	used := uses[id]
	if issue == nil || used.Count < 0 || used.Count >= maxInviteUseLimit ||
		(issue.MaxUses != 0 && used.Count >= issue.MaxUses) || (used.Count > 0 && used.IssueSignature != issue.Signature) {
		return false
	}
	uses[id] = InvitePolicyUse{IssueSignature: issue.Signature, Count: used.Count + 1}
	return true
}

func supportsInviteBatchNewcomer(child, current State, record EpochRecord,
	receipt *ScopedInviteReceipt, newcomer TextNewcomerAdmissionOpening) bool {
	actor, channel := receipt.Actor, record.ChannelID
	if !retainedPersonalDenyReader(child, current, record, actor) ||
		child.canLoadEpoch(actor, channel, ArchiveEpoch) != newcomer.Archive ||
		current.canLoadEpoch(actor, channel, ArchiveEpoch) != newcomer.Archive ||
		child.KeyRecipients[actor.DeviceID].PublicKey != receipt.Admission.Claim.AgreementKey {
		return false
	}
	for _, snapshot := range []State{child, current} {
		subject := snapshot.Members[actor.ProfileID]
		if len(subject.Roles) != 0 ||
			(snapshot.CheckGrant(subject, snapshot.scope(snapshot.Channels[channel]), "message.send", 0) == Allowed) != newcomer.CanSend {
			return false
		}
	}
	return true
}

func inviteBatchHasAttestation(ctx context.Context, query SessionQuery, revision int64) (bool, error) {
	var attested bool
	err := query.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM protected_policy_attestations WHERE revision=? AND length(signature)=64
		UNION ALL SELECT 1 FROM protected_policy_attestations_v2 WHERE revision=? AND length(signature)=64
	)`, revision, revision).Scan(&attested)
	return attested, err
}

func readInviteBatchPolicy(ctx context.Context, query SessionQuery, revision int64) (State, PolicyProof, error) {
	proof, err := readAttestedProof(ctx, query, revision)
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	snapshot, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy_proofs WHERE revision=?", revision))
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	snapshot.PolicyAnchored = true
	err = checkPolicyHead(snapshot, revision, proof)
	return snapshot, proof, err
}

func inviteBatchIssuerAuthority(ctx context.Context, query SessionQuery, baseState State, base PolicyProof, issue *InviteIssuance,
	cache *textChannelPolicyTreeCache) (*InviteAdmissionIssuerAuthority, error) {
	if issue == nil || issue.PolicyRevision <= 0 || issue.PolicyRevision > base.Draft.Revision {
		return nil, nil
	}
	state, head := baseState, base
	if issue.PolicyRevision != base.Draft.Revision {
		attested, err := inviteBatchHasAttestation(ctx, query, issue.PolicyRevision)
		if err != nil || !attested {
			return nil, err
		}
		state, head, err = readInviteBatchPolicy(ctx, query, issue.PolicyRevision)
		if err != nil {
			return nil, err
		}
	}
	version := head.Draft.TextProjectionVersion
	if !supportsScopedInviteReceipts(version) || version > base.Draft.TextProjectionVersion || head.Digest != issue.PolicyDigest {
		return nil, nil
	}
	scope, err := inviteAdmissionAttestedScope(state, head, cache)
	if err != nil {
		return nil, err
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	root, proof, err := state.inviteIssuerCommitment(seed, issue.Issuer)
	if err != nil || proof == nil {
		return nil, err
	}
	if root != scope.Issuers {
		return nil, ErrPolicyConflict
	}
	return &InviteAdmissionIssuerAuthority{InviteAdmissionScopeOpening: scope, Opening: proof}, nil
}
