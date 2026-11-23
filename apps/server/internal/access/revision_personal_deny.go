package access

import "context"

// RevisionPersonalDenyEvidence reopens the previously attested audience at
// the original position. A removed profile is represented by an opaque leaf.
type RevisionPersonalDenyEvidence struct {
	PersonalDenyReadEvidence
	GroupedAudience *RevisionGroupedAudience      `json:"groupedAudience"`
	RemovedGroup    *LivePersonalDenyRemovedGroup `json:"removedGroup,omitempty"`
}

type revisionPersonalDenyBasis struct {
	previous    State
	predecessor PolicyProof
	successor   State
	evidence    PersonalDenyReadEvidence
}

// The marked archive record has been verified by the caller. Use its
// immutable signed policy so a stored revision remains verifiable later.
func readRevisionPersonalDenyBasis(ctx context.Context, query SessionQuery, archive EpochProof,
	cache *textChannelPolicyTreeCache) (*revisionPersonalDenyBasis, error) {
	record := archive.Record
	if record.Purpose != ArchiveEpoch || record.ArchiveTransitionDigest == "" || !record.ValidTransitionDigests() {
		return nil, nil
	}
	successor, head, err := readHistoricalTextSignerBasis(ctx, query, record)
	if err != nil {
		return nil, err
	}
	if head.Draft.TextProjectionVersion < TextGroupedRevisionAudienceProjectionVersion {
		return nil, nil
	}
	successor.PolicyAnchored = true
	basis, err := readPersonalDenyBasisAt(ctx, query, successor, head, record, archive.Principal, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	proof, err := basis.disclose(successor, archive, cache)
	if err != nil || proof == nil {
		return nil, err
	}
	evidence := *proof
	evidence.PreviousTextPolicy = nil
	return &revisionPersonalDenyBasis{previous: basis.previous, predecessor: basis.predecessor, successor: successor, evidence: evidence}, nil
}

func (basis *revisionPersonalDenyBasis) authorDisclosure(author Principal, channel string, position uint64,
	cache *textChannelPolicyTreeCache) (*TextChannelPolicyDisclosure, error) {
	if author.ProfileID == basis.evidence.TargetProfileID {
		return nil, nil
	}
	return revisionDenyAuthorDisclosure(basis.previous, basis.successor, basis.predecessor, author, channel, position, cache)
}

func offlineRevisionEvidence(ctx context.Context, query SessionQuery, state State, basis RevisionBasis, author Principal,
	cache *textChannelPolicyTreeCache) (*RevisionPersonalDenyEvidence, error) {
	record := basis.Archive.Record
	if !revisionDenyArchiveCoversCurrent(state, basis) {
		return nil, nil
	}
	historical, err := readRevisionPersonalDenyBasis(ctx, query, basis.Archive, cache)
	if err != nil || historical == nil {
		return nil, err
	}
	channel, position := record.ChannelID, basis.Position
	proof, err := historical.authorDisclosure(author, channel, position, cache)
	if err != nil || proof == nil {
		return nil, err
	}
	target := historical.evidence.TargetProfileID
	groupedAudience, removedGroups, err := revisionDenyAudience(historical.previous, historical.predecessor, channel, position,
		basis.Recipients, []string{target})
	if err != nil || groupedAudience == nil {
		return nil, err
	}
	evidence := &RevisionPersonalDenyEvidence{PersonalDenyReadEvidence: historical.evidence, GroupedAudience: groupedAudience}
	evidence.PreviousTextPolicy = proof
	if group, found := removedGroups[target]; found {
		evidence.RemovedGroup = &group
	}
	return evidence, nil
}
