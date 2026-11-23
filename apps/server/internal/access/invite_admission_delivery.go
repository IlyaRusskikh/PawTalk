package access

import "context"

// InviteAdmissionReadEvidence authenticates one admission transition
// without exposing the rotation recipient roster or its openings.
type InviteAdmissionReadEvidence struct {
	PreviousRevision         int64                          `json:"previousRevision"`
	PreviousHead             string                         `json:"previousHead"`
	SuccessorHead            string                         `json:"successorHead"`
	Draft                    *ScopedInviteReceipt           `json:"draft"`
	Newcomer                 TextNewcomerAdmissionOpening   `json:"newcomer"`
	NewcomerTextPolicy       *TextChannelPolicyDisclosure   `json:"newcomerTextPolicy"`
	IssuerAuthority          InviteAdmissionIssuerAuthority `json:"issuerAuthority"`
	Freshness                InviteAdmissionFreshness       `json:"freshness"`
	PreviousSignerTextPolicy *TextChannelPolicyDisclosure   `json:"previousSignerTextPolicy"`
	PreviousTextPolicy       *TextChannelPolicyDisclosure   `json:"previousTextPolicy,omitempty"`
}

// The caller must verify the immutable signed epoch before requesting this
// basis. Authorization for a current package remains separate.
func readInviteAdmissionEpochBasis(ctx context.Context, query SessionQuery, successor State, head PolicyProof,
	epoch EpochProof, cache *textChannelPolicyTreeCache) (*inviteAdmissionRotationBasis, error) {
	record := epoch.Record
	expected := record.LiveTransitionDigest
	if record.Purpose == ArchiveEpoch {
		expected = record.ArchiveTransitionDigest
	}
	if expected == "" || head.Draft.Action != RedeemPolicyInvite {
		return nil, nil
	}
	recipients, err := successor.rotationRecipients(record.ChannelID, record.Purpose)
	if err != nil {
		return nil, err
	}
	basis, err := readInviteAdmissionRotationBasis(ctx, query, successor, head,
		RotationTask{EpochRecord: record, Recipients: recipients}, epoch.Principal, cache)
	if err != nil {
		return nil, err
	}
	if basis == nil {
		return nil, ErrEpochConflict
	}
	digest, err := inviteAdmissionTransitionDigest(record, *basis.rotation)
	if err != nil {
		return nil, err
	}
	if digest != expected {
		return nil, ErrEpochConflict
	}
	return basis, nil
}

func (basis *inviteAdmissionRotationBasis) readEvidence() *InviteAdmissionReadEvidence {
	witness := basis.rotation
	return &InviteAdmissionReadEvidence{
		PreviousRevision: witness.PreviousRevision, PreviousHead: witness.PreviousHead, SuccessorHead: witness.SuccessorHead,
		Draft: witness.Draft, Newcomer: witness.Newcomer, NewcomerTextPolicy: witness.NewcomerTextPolicy,
		IssuerAuthority: witness.IssuerAuthority, Freshness: witness.Freshness, PreviousSignerTextPolicy: witness.PreviousTextPolicy,
	}
}

func (basis *inviteAdmissionRotationBasis) disclosePackage(successor, current State, record EpochRecord,
	viewer Principal, cache *textChannelPolicyTreeCache) (*InviteAdmissionReadEvidence, error) {
	if !retainedPersonalDenyReader(successor, current, record, viewer) {
		return nil, ChannelRestricted
	}
	witness := basis.readEvidence()
	if viewer == witness.Draft.Actor {
		return witness, nil
	}
	if !retainedPersonalDenyReader(basis.previous, successor, record, viewer) {
		return nil, ChannelRestricted
	}
	disclosure, err := textChannelDisclosure(basis.previous, basis.predecessor, record.ChannelID, viewer.DeviceID, cache, 0)
	if err != nil {
		return nil, err
	}
	if disclosure == nil || disclosure.Recipient == nil {
		return nil, ErrPolicyConflict
	}
	witness.PreviousTextPolicy = disclosure
	return witness, nil
}

func inviteAdmissionPackageEvidence(ctx context.Context, query SessionQuery, current, successor State, head PolicyProof,
	epoch EpochProof, viewer Principal, cache *textChannelPolicyTreeCache) (*InviteAdmissionReadEvidence, error) {
	basis, err := readInviteAdmissionEpochBasis(ctx, query, successor, head, epoch, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	return basis.disclosePackage(successor, current, epoch.Record, viewer, cache)
}

func setInviteAdmissionSigningProof(ctx context.Context, query SessionQuery, policies *historicalEpochSigningPolicies,
	epoch *EpochProof, cache *textChannelPolicyTreeCache) error {
	if epoch.inviteAdmissionBaseRevision != 0 {
		batch, err := readInviteAdmissionBatchEpochBasis(ctx, query, policies.basis, policies.head, *epoch, cache)
		if err != nil {
			return err
		}
		if epoch.Record.Purpose == ArchiveEpoch {
			epoch.ArchiveInviteAdmissions = batch.readEvidence()
		} else {
			epoch.LiveInviteAdmissions = batch.readEvidence()
		}
		return nil
	}
	basis, err := readInviteAdmissionEpochBasis(ctx, query, policies.basis, policies.head, *epoch, cache)
	if err != nil || basis == nil {
		return err
	}
	if epoch.Record.Purpose == ArchiveEpoch {
		epoch.ArchiveInviteAdmission = basis.readEvidence()
	} else {
		epoch.LiveInviteAdmission = basis.readEvidence()
	}
	return nil
}
