package access

import "context"

// RoleViewDenyReadEvidence opens only the prior signer and addressed reader.
type RoleViewDenyReadEvidence struct {
	RoleViewDenyEvidence
	PreviousSignerTextPolicy *TextChannelPolicyDisclosure `json:"previousSignerTextPolicy"`
}

func verifiedLiveRoleViewDenyBasis(ctx context.Context, query SessionQuery, successor State, head PolicyProof,
	record EpochRecord, viewer Principal, cache *textChannelPolicyTreeCache) (*roleViewDenyBasis, error) {
	if record.Purpose != LiveEpoch {
		return nil, nil
	}
	return verifiedRoleViewDenyBasis(ctx, query, successor, head, record, viewer, cache)
}

func verifiedRoleViewDenyBasis(ctx context.Context, query SessionQuery, successor State, head PolicyProof,
	record EpochRecord, viewer Principal, cache *textChannelPolicyTreeCache) (*roleViewDenyBasis, error) {
	expected := record.LiveTransitionDigest
	if record.Purpose == ArchiveEpoch {
		expected = record.ArchiveTransitionDigest
	}
	if expected == "" || head.Draft.Action != EditScopedChannelACLRoleRules {
		return nil, nil
	}
	successor.PolicyAnchored = true
	recipients, err := successor.rotationRecipients(record.ChannelID, record.Purpose)
	if err != nil {
		return nil, err
	}
	basis, err := readRoleViewDenyBasis(ctx, query, successor, head, RotationTask{EpochRecord: record, Recipients: recipients}, viewer, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	digest, err := roleViewDenyTransitionDigest(record, basis.rotation.RoleViewDenyEvidence)
	if err != nil {
		return nil, err
	}
	if digest != expected {
		return nil, ErrEpochConflict
	}
	return basis, nil
}

func currentRoleViewDenyEvidence(ctx context.Context, query SessionQuery, current, successor State, head PolicyProof,
	epoch EpochProof, viewer Principal, cache *textChannelPolicyTreeCache) (*RoleViewDenyReadEvidence, error) {
	record := epoch.Record
	if record.Generation != current.currentGeneration(record.ChannelID, record.Purpose) ||
		!retainedPersonalDenyReader(successor, current, record, viewer) {
		return nil, nil
	}
	basis, err := verifiedRoleViewDenyBasis(ctx, query, successor, head, record, viewer, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	return basis.disclose(successor, epoch, cache)
}

func (basis *roleViewDenyBasis) disclose(successor State, epoch EpochProof,
	cache *textChannelPolicyTreeCache) (*RoleViewDenyReadEvidence, error) {
	record := epoch.Record
	if !retainedPersonalDenyReader(basis.previous, successor, record, epoch.Principal) {
		return nil, nil
	}
	signer, err := textChannelDisclosure(basis.previous, basis.predecessor, record.ChannelID, epoch.Principal.DeviceID, cache, 0)
	if err != nil || signer == nil || signer.Recipient == nil {
		return nil, err
	}
	return &RoleViewDenyReadEvidence{RoleViewDenyEvidence: basis.rotation.RoleViewDenyEvidence, PreviousSignerTextPolicy: signer}, nil
}
