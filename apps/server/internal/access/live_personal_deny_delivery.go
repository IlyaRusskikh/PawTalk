package access

import "context"

// PersonalDenyReadEvidence discloses only the exact transition and the
// preceding scoped admissions of the signer and the addressed viewer.
type PersonalDenyReadEvidence struct {
	PreviousRevision         int64                        `json:"previousRevision"`
	PreviousHead             string                       `json:"previousHead"`
	SuccessorHead            string                       `json:"successorHead"`
	OperationID              string                       `json:"operationId"`
	Actor                    Principal                    `json:"actor"`
	TargetProfileID          string                       `json:"targetProfileId"`
	EditorProof              string                       `json:"editorProof"`
	Authority                LivePersonalDenyACLAuthority `json:"authority"`
	RankBasis                ChannelACLRankBasis          `json:"rankBasis"`
	PreviousTextPolicy       *TextChannelPolicyDisclosure `json:"previousTextPolicy"`
	PreviousSignerTextPolicy *TextChannelPolicyDisclosure `json:"previousSignerTextPolicy"`
}

func personalDenyReadEvidence(ctx context.Context, query SessionQuery, current State, epoch EpochProof,
	viewer Principal, cache *textChannelPolicyTreeCache) (*PersonalDenyReadEvidence, error) {
	record := epoch.Record
	if record.Generation != current.currentGeneration(record.ChannelID, record.Purpose) {
		return nil, nil
	}
	basis, err := readPersonalDenyBasis(ctx, query, current, record, viewer, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	return basis.disclose(current, epoch, cache)
}

// A current addressed package can outlive its policy revision when an unrelated
// change does not rotate the channel. Its signer and transition still come from
// the signed basis of the epoch, while the viewer must retain current admission.
func currentPersonalDenyReadEvidence(ctx context.Context, query SessionQuery, current, successor State, head PolicyProof,
	epoch EpochProof, viewer Principal, cache *textChannelPolicyTreeCache) (*PersonalDenyReadEvidence, error) {
	record := epoch.Record
	if record.Generation != current.currentGeneration(record.ChannelID, record.Purpose) ||
		!retainedPersonalDenyReader(successor, current, record, viewer) {
		return nil, nil
	}
	successor.PolicyAnchored = true
	basis, err := readPersonalDenyBasisAt(ctx, query, successor, head, record, viewer, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	return basis.disclose(successor, epoch, cache)
}

type personalDenyReadBasis struct {
	previous    State
	predecessor PolicyProof
	evidence    PersonalDenyReadEvidence
	signers     map[Principal]*PersonalDenyReadEvidence
}

func readPersonalDenyBasis(ctx context.Context, query SessionQuery, current State, record EpochRecord,
	viewer Principal, cache *textChannelPolicyTreeCache) (*personalDenyReadBasis, error) {
	if record.LiveTransitionDigest == "" && record.ArchiveTransitionDigest == "" {
		return nil, nil
	}
	head, err := readPolicyHead(ctx, query)
	if err != nil {
		return nil, err
	}
	return readPersonalDenyBasisAt(ctx, query, current, head, record, viewer, cache)
}

func readPersonalDenyBasisAt(ctx context.Context, query SessionQuery, state State, head PolicyProof,
	record EpochRecord, viewer Principal, cache *textChannelPolicyTreeCache) (*personalDenyReadBasis, error) {
	transitionDigest := record.LiveTransitionDigest
	if record.Purpose == ArchiveEpoch {
		transitionDigest = record.ArchiveTransitionDigest
	}
	if transitionDigest == "" {
		return nil, nil
	}
	if head.Draft.Revision != record.Revision || head.Draft.ResultDigest != record.PolicyDigest {
		return nil, nil
	}
	channel := record.ChannelID
	recipients, err := state.rotationRecipients(channel, record.Purpose)
	if err != nil {
		return nil, err
	}
	evidence, err := personalDenyRotationEvidence(ctx, query, state, head, RotationTask{EpochRecord: record, Recipients: recipients}, viewer, cache)
	if err != nil || evidence == nil {
		return nil, err
	}
	digest, err := personalDenyTransitionDigest(record, *evidence)
	if err != nil {
		return nil, err
	}
	if digest != transitionDigest {
		return nil, ErrEpochConflict
	}
	previous, preceding, err := readPrecedingPolicyState(ctx, query, head.Draft)
	if err != nil {
		return nil, err
	}
	if !retainedPersonalDenyReader(previous, state, record, viewer) {
		return nil, nil
	}
	return &personalDenyReadBasis{previous: previous, predecessor: preceding,
		evidence: PersonalDenyReadEvidence{
			PreviousRevision: evidence.PreviousRevision, PreviousHead: evidence.PreviousHead, SuccessorHead: evidence.SuccessorHead,
			OperationID: evidence.OperationID, Actor: evidence.Actor, TargetProfileID: evidence.TargetProfileID, EditorProof: evidence.EditorProof,
			Authority: evidence.Authority, RankBasis: evidence.RankBasis, PreviousTextPolicy: evidence.PreviousTextPolicy,
		}, signers: make(map[Principal]*PersonalDenyReadEvidence)}, nil
}

func retainedPersonalDenyReader(previous, current State, record EpochRecord, actor Principal) bool {
	channel := record.ChannelID
	return previous.hasPolicyDevice(actor) && current.hasPolicyDevice(actor) &&
		previous.canLoadEpoch(actor, channel, record.Purpose) && current.canLoadEpoch(actor, channel, record.Purpose) &&
		previous.KeyRecipients[actor.DeviceID] == current.KeyRecipients[actor.DeviceID] &&
		previous.Admissions[channel][actor.ProfileID].FirstPosition != 0 &&
		previous.Admissions[channel][actor.ProfileID] == current.Admissions[channel][actor.ProfileID]
}

func (basis *personalDenyReadBasis) disclose(current State, epoch EpochProof, cache *textChannelPolicyTreeCache) (*PersonalDenyReadEvidence, error) {
	if proof, found := basis.signers[epoch.Principal]; found {
		return proof, nil
	}
	if !retainedPersonalDenyReader(basis.previous, current, epoch.Record, epoch.Principal) {
		basis.signers[epoch.Principal] = nil
		return nil, nil
	}
	signer, err := textChannelDisclosure(basis.previous, basis.predecessor, epoch.Record.ChannelID, epoch.Principal.DeviceID, cache, 0)
	if err != nil {
		return nil, err
	}
	proof := basis.evidence
	proof.PreviousSignerTextPolicy = signer
	basis.signers[epoch.Principal] = &proof
	return &proof, nil
}
