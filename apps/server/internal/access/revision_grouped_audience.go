package access

import "encoding/hex"

// RevisionGroupedAudience opens only the limited recipients of this original.
// Full-history recipients use the current archive package instead.
type RevisionGroupedAudience struct {
	Profiles map[string]string                 `json:"profiles"`
	Openings map[string]RotationProfileOpening `json:"openings"`
}

func revisionGroupedAudience(state State, basis PolicyProof, channel string, position uint64,
	recipients []RevisionRecipient) (*RevisionGroupedAudience, error) {
	var seed [32]byte
	if len(basis.Draft.TextProjectionSeed) != 64 {
		return nil, ErrPolicyConflict
	}
	if _, err := hex.Decode(seed[:], []byte(basis.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	readers := state.channelReaders(state.Channels[channel])
	groups := &RevisionGroupedAudience{
		Profiles: make(map[string]string, len(recipients)),
		Openings: make(map[string]RotationProfileOpening),
	}
	for _, addressed := range recipients {
		recipient, known := state.KeyRecipients[addressed.ID]
		full, admitted := readers[recipient.ProfileID]
		if !known || !admitted || full || addressed.PublicKey != recipient.PublicKey ||
			!state.Admissions[channel][recipient.ProfileID].CanRead(position, false) {
			return nil, ErrEpochRecipients
		}
		groups.Profiles[addressed.ID] = recipient.ProfileID
		if _, opened := groups.Openings[recipient.ProfileID]; !opened {
			groups.Openings[recipient.ProfileID] = textRevisionProfileOpening(seed, channel, recipient.ProfileID)
		}
	}
	return groups, nil
}
