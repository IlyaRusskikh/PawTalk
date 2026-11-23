package access

import (
	"context"
	"slices"
)

type RevisionRoleViewDenyEvidence struct {
	RoleViewDenyReadEvidence
	GroupedAudience *RevisionGroupedAudience                `json:"groupedAudience"`
	RemovedGroups   map[string]LivePersonalDenyRemovedGroup `json:"removedGroups"`
}

type RevisionRoleViewDenyReadEvidence struct {
	RoleViewDenyReadEvidence
	PreviousRecipientPolicy *TextChannelPolicyDisclosure `json:"previousRecipientPolicy,omitempty"`
}

type revisionRoleViewDenyBasis struct {
	previous    State
	predecessor PolicyProof
	successor   State
	evidence    RoleViewDenyReadEvidence
}

// The caller has already verified the archived epoch signature. Reopen the
// immutable policy at that epoch rather than requiring it to be the head.
func readRevisionRoleViewDenyBasis(ctx context.Context, query SessionQuery, archive EpochProof,
	cache *textChannelPolicyTreeCache) (*revisionRoleViewDenyBasis, error) {
	record := archive.Record
	if record.Purpose != ArchiveEpoch || record.ArchiveTransitionDigest == "" || !record.ValidTransitionDigests() {
		return nil, nil
	}
	successor, head, err := readHistoricalTextSignerBasis(ctx, query, record)
	if err != nil {
		return nil, err
	}
	basis, err := verifiedRoleViewDenyBasis(ctx, query, successor, head, record, archive.Principal, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	proof, err := basis.disclose(successor, archive, cache)
	if err != nil || proof == nil {
		return nil, err
	}
	evidence := *proof
	evidence.PreviousTextPolicy = nil
	return &revisionRoleViewDenyBasis{previous: basis.previous, predecessor: basis.predecessor, successor: successor, evidence: evidence}, nil
}

func (basis *revisionRoleViewDenyBasis) authorDisclosure(author Principal, channel string, position uint64,
	cache *textChannelPolicyTreeCache) (*TextChannelPolicyDisclosure, error) {
	if slices.Contains(basis.evidence.Effect.ExcludedProfiles, author.ProfileID) {
		return nil, nil
	}
	return revisionDenyAuthorDisclosure(basis.previous, basis.successor, basis.predecessor, author, channel, position, cache)
}

func offlineRoleViewDenyRevisionEvidence(ctx context.Context, query SessionQuery, state State, basis RevisionBasis, author Principal,
	cache *textChannelPolicyTreeCache) (*RevisionRoleViewDenyEvidence, error) {
	if !revisionDenyArchiveCoversCurrent(state, basis) {
		return nil, nil
	}
	historical, err := readRevisionRoleViewDenyBasis(ctx, query, basis.Archive, cache)
	if err != nil || historical == nil {
		return nil, err
	}
	channel, position := basis.Archive.Record.ChannelID, basis.Position
	proof, err := historical.authorDisclosure(author, channel, position, cache)
	if err != nil || proof == nil {
		return nil, err
	}
	grouped, removed, err := revisionDenyAudience(historical.previous, historical.predecessor, channel, position,
		basis.Recipients, historical.evidence.Effect.ExcludedProfiles)
	if err != nil || grouped == nil {
		return nil, err
	}
	evidence := historical.evidence
	evidence.PreviousTextPolicy = proof
	return &RevisionRoleViewDenyEvidence{RoleViewDenyReadEvidence: evidence, GroupedAudience: grouped, RemovedGroups: removed}, nil
}

func revisionRoleViewDenyReadEvidence(ctx context.Context, query SessionQuery, record RevisionRecord, viewer Principal,
	position uint64, addressed bool, cache *textChannelPolicyTreeCache) (*RevisionRoleViewDenyReadEvidence, error) {
	archive := record.Archive.Record
	if archive.Revision != record.PolicyRevision || archive.PolicyDigest != record.PolicyDigest {
		return nil, nil
	}
	basis, err := readRevisionRoleViewDenyBasis(ctx, query, record.Archive, cache)
	if err != nil || basis == nil {
		return nil, err
	}
	author, err := basis.authorDisclosure(record.Author, archive.ChannelID, position, cache)
	if err != nil || author == nil {
		return nil, err
	}
	author.GroupedAudienceProof = nil
	compact := RevisionRoleViewDenyReadEvidence{RoleViewDenyReadEvidence: basis.evidence}
	compact.PreviousTextPolicy = author
	if addressed {
		if slices.Contains(basis.evidence.Effect.ExcludedProfiles, viewer.ProfileID) {
			return nil, nil
		}
		compact.PreviousRecipientPolicy, err = revisionDenyRecipientDisclosure(basis.previous, basis.successor, basis.predecessor,
			viewer, archive.ChannelID, position, cache)
		if err != nil || compact.PreviousRecipientPolicy == nil {
			return nil, err
		}
	}
	return &compact, nil
}
