package access

import (
	"encoding/hex"
	"slices"
)

func revisionDenyArchiveCoversCurrent(state State, basis RevisionBasis) bool {
	record := basis.Archive.Record
	return record.Revision == basis.PolicyRevision && record.PolicyDigest == basis.PolicyDigest &&
		record.ArchiveThrough == state.currentGeneration(record.ChannelID, LiveEpoch)
}

func revisionDenyAuthorDisclosure(previous, successor State, predecessor PolicyProof, author Principal, channel string,
	position uint64, cache *textChannelPolicyTreeCache) (*TextChannelPolicyDisclosure, error) {
	subject := successor.Members[author.ProfileID]
	subject.TimeoutUntil = 0 // Historical proofs bind policy grants; active timeouts gate commits.
	if !retainedPersonalDenyReader(previous, successor, EpochRecord{ChannelID: channel, Purpose: LiveEpoch}, author) ||
		!canReadRevisionPosition(previous, channel, author.ProfileID, position) ||
		!canReadRevisionPosition(successor, channel, author.ProfileID, position) ||
		successor.CheckGrant(subject, successor.scope(successor.Channels[channel]), "message.send", 0) != Allowed {
		return nil, nil
	}
	proof, err := textChannelDisclosure(previous, predecessor, channel, author.DeviceID, cache, position)
	if err != nil || proof == nil || proof.Recipient == nil {
		return nil, err
	}
	if proof.Recipient.Statement.CanSend == nil || !*proof.Recipient.Statement.CanSend || proof.GroupedAudienceProof == nil {
		return nil, nil
	}
	// The flat predecessor opening would let a writer test guessed
	// recipient IDs using the known survivors. Only the grouped proof is needed.
	proof.AudienceProof = nil
	return proof, nil
}

func canReadRevisionPosition(state State, channel, profile string, position uint64) bool {
	history := state.CheckGrant(state.Members[profile], state.scope(state.Channels[channel]), "history.full", 0) == Allowed
	return state.Admissions[channel][profile].CanRead(position, history)
}

func revisionDenyRecipientDisclosure(previous, successor State, predecessor PolicyProof, reader Principal, channel string,
	position uint64, cache *textChannelPolicyTreeCache) (*TextChannelPolicyDisclosure, error) {
	live := EpochRecord{ChannelID: channel, Purpose: LiveEpoch}
	if !retainedPersonalDenyReader(previous, successor, live, reader) ||
		!previous.Admissions[channel][reader.ProfileID].CanRead(position, false) ||
		previous.canLoadEpoch(reader, channel, ArchiveEpoch) || successor.canLoadEpoch(reader, channel, ArchiveEpoch) {
		return nil, nil
	}
	proof, err := textChannelDisclosure(previous, predecessor, channel, reader.DeviceID, cache, 0)
	if err != nil || proof == nil || proof.Recipient == nil {
		return nil, err
	}
	return proof, nil
}

func revisionDenyAudience(previous State, predecessor PolicyProof, channel string, position uint64,
	expected []RevisionRecipient, excludedProfiles []string) (*RevisionGroupedAudience, map[string]LivePersonalDenyRemovedGroup, error) {
	oldRecipients, err := revisionLimitedRecipients(previous, channel, position)
	if err != nil {
		return nil, nil, err
	}
	excluded := make(map[string]bool, len(excludedProfiles))
	for _, profile := range excludedProfiles {
		excluded[profile] = true
	}
	removed := make(map[string][][2]string)
	survivors := make([]RevisionRecipient, 0, len(oldRecipients))
	for _, recipient := range oldRecipients {
		profile := previous.KeyRecipients[recipient.ID].ProfileID
		if excluded[profile] {
			removed[profile] = append(removed[profile], [2]string{recipient.ID, recipient.PublicKey})
		} else {
			survivors = append(survivors, recipient)
		}
	}
	if !slices.Equal(survivors, expected) {
		return nil, nil, nil
	}
	grouped, err := revisionGroupedAudience(previous, predecessor, channel, position, survivors)
	if err != nil {
		return nil, nil, err
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(predecessor.Draft.TextProjectionSeed)); err != nil {
		return nil, nil, ErrPolicyConflict
	}
	groups := make(map[string]LivePersonalDenyRemovedGroup, len(removed))
	for profile, members := range removed {
		opening := textRevisionProfileOpening(seed, channel, profile)
		digest, err := textRevisionProfileMembersDigest(members, opening.ContentSalt)
		if err != nil {
			return nil, nil, err
		}
		groups[profile] = LivePersonalDenyRemovedGroup{Salt: opening.Salt, Digest: digest}
	}
	return grouped, groups, nil
}
