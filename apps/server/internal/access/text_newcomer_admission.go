package access

import (
	"encoding/hex"
	"strconv"
)

// TextNewcomerAdmissionOpening describes a roleless first-time profile in one
// text channel. Independent admission proof must establish its freshness.
type TextNewcomerAdmissionOpening struct {
	Salt    string `json:"salt"`
	Visible bool   `json:"visible"`
	Archive bool   `json:"archive"`
	CanSend bool   `json:"canSend"`
}

func (s State) textNewcomerAdmissionCommitment(channelID string, seed [32]byte) (string, TextNewcomerAdmissionOpening, error) {
	channel, exists := s.Channels[channelID]
	if !exists || channel.Kind != "text" {
		return "", TextNewcomerAdmissionOpening{}, ChannelRestricted
	}
	// Resolve inherited or local rules first. A genuinely new profile has
	// neither an ownership identity nor an applicable personal overwrite.
	effective := s.scope(channel).effectiveACL()
	scope := Scope{Kind: channel.Kind, Local: &ACL{Roles: effective.Roles}}
	policy := s.Policy
	policy.Owner = ""
	subject := Subject{ID: "newcomer", Active: true}
	salt := textRecipientBlind(seed, 22, channelID, "")
	opening := TextNewcomerAdmissionOpening{Salt: hex.EncodeToString(salt[:]),
		Visible: policy.CheckGrant(subject, scope, ChannelView, 0) == Allowed}
	if opening.Visible {
		opening.Archive = policy.CheckGrant(subject, scope, "history.full", 0) == Allowed
		opening.CanSend = policy.CheckGrant(subject, scope, "message.send", 0) == Allowed
	}
	frame, err := SignatureFrame("pawtalk-text-newcomer-admission-v1", opening.Salt,
		strconv.FormatBool(opening.Visible), strconv.FormatBool(opening.Archive), strconv.FormatBool(opening.CanSend))
	if err != nil {
		return "", TextNewcomerAdmissionOpening{}, err
	}
	return hexHash(frame), opening, nil
}
