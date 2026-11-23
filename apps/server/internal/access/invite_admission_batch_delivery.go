package access

import "context"

type InviteAdmissionBatchReadEvidence struct {
	PreviousRevision         int64                        `json:"previousRevision"`
	PreviousHead             string                       `json:"previousHead"`
	SuccessorHead            string                       `json:"successorHead"`
	Newcomer                 TextNewcomerAdmissionOpening `json:"newcomer"`
	Admissions               []InviteAdmissionBatchItem   `json:"admissions"`
	PreviousSignerTextPolicy *TextChannelPolicyDisclosure `json:"previousSignerTextPolicy"`
	PreviousTextPolicy       *TextChannelPolicyDisclosure `json:"previousTextPolicy,omitempty"`
}

type inviteAdmissionBatchBasis struct {
	previous State
	base     PolicyProof
	evidence *InviteAdmissionBatchEvidence
}

func readInviteAdmissionBatchEpochBasis(ctx context.Context, query SessionQuery, successor State, head PolicyProof,
	epoch EpochProof, cache *textChannelPolicyTreeCache) (*inviteAdmissionBatchBasis, error) {
	record := epoch.Record
	marker := record.LiveTransitionDigest
	if record.Purpose == ArchiveEpoch {
		marker = record.ArchiveTransitionDigest
	}
	revision := epoch.inviteAdmissionBaseRevision
	if revision <= 0 || revision > record.Revision-2 || marker == "" || head.Draft.Action != RedeemPolicyInvite {
		return nil, ErrEpochConflict
	}
	previous, base, err := readInviteBatchPolicy(ctx, query, revision)
	if err != nil {
		return nil, err
	}
	recipients, err := successor.rotationRecipients(record.ChannelID, record.Purpose)
	if err != nil {
		return nil, err
	}
	successor.PolicyAnchored = true
	evidence, err := buildInviteAdmissionBatchAt(ctx, query, successor, previous, base, head,
		RotationTask{EpochRecord: record, Recipients: recipients}, epoch.Principal, cache, false)
	if err != nil {
		return nil, err
	}
	if evidence == nil {
		return nil, ErrEpochConflict
	}
	digest, err := inviteAdmissionBatchDigest(record, *evidence)
	if err != nil {
		return nil, err
	}
	if digest != marker {
		return nil, ErrEpochConflict
	}
	return &inviteAdmissionBatchBasis{previous: previous, base: base, evidence: evidence}, nil
}

func (basis *inviteAdmissionBatchBasis) readEvidence() *InviteAdmissionBatchReadEvidence {
	witness := basis.evidence
	return &InviteAdmissionBatchReadEvidence{
		PreviousRevision: witness.PreviousRevision, PreviousHead: witness.PreviousHead, SuccessorHead: witness.SuccessorHead,
		Newcomer: witness.Newcomer, Admissions: witness.Admissions, PreviousSignerTextPolicy: witness.PreviousTextPolicy,
	}
}

func inviteAdmissionBatchPackageEvidence(ctx context.Context, query SessionQuery, current, successor State, head PolicyProof,
	epoch EpochProof, viewer Principal, cache *textChannelPolicyTreeCache) (*InviteAdmissionBatchReadEvidence, error) {
	record := epoch.Record
	if !retainedPersonalDenyReader(successor, current, record, viewer) {
		return nil, ChannelRestricted
	}
	basis, err := readInviteAdmissionBatchEpochBasis(ctx, query, successor, head, epoch, cache)
	if err != nil {
		return nil, err
	}
	witness := basis.readEvidence()
	for _, item := range witness.Admissions {
		if item.Draft.Actor == viewer {
			return witness, nil
		}
	}
	if !retainedPersonalDenyReader(basis.previous, successor, record, viewer) {
		return nil, ChannelRestricted
	}
	witness.PreviousTextPolicy, err = textChannelDisclosure(basis.previous, basis.base, record.ChannelID, viewer.DeviceID, cache, 0)
	if err != nil {
		return nil, err
	}
	if witness.PreviousTextPolicy == nil || witness.PreviousTextPolicy.Recipient == nil {
		return nil, ErrPolicyConflict
	}
	return witness, nil
}
