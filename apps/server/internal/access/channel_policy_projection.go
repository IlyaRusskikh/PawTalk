package access

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"strings"
)

type TextChannelKeyRecipient struct {
	RecipientID string `json:"id"`
	ProfileID   string `json:"profileId"`
	Kind        string `json:"kind"`
	PublicKey   string `json:"publicKey"`
	SigningKey  string `json:"signingKey"`
	Archive     bool   `json:"archive"`
}

// TextChannelKeyProjection names the exact eligible recipients and device
// signing keys for one channel. Other channels, role assignments, and each
// reader's admission position are outside this projection.
type TextChannelKeyProjection struct {
	Kind       string                    `json:"kind"`
	Recipients []TextChannelKeyRecipient `json:"recipients"`
}

func (s State) TextChannelKeyProjection(channelID string) (TextChannelKeyProjection, error) {
	channel, ok := s.Channels[channelID]
	if !ok || channel.Kind != "text" {
		return TextChannelKeyProjection{}, ChannelRestricted
	}
	projection := TextChannelKeyProjection{Kind: "text", Recipients: []TextChannelKeyRecipient{}}
	readers := s.channelReaders(channel)
	for id, key := range s.KeyRecipients {
		archive, admitted := readers[key.ProfileID]
		if !admitted {
			continue
		}
		if !isDigest(id) || !isDigest(key.ProfileID) || !isDigest(key.PublicKey) || (key.Kind != "device" && key.Kind != "recovery") {
			return TextChannelKeyProjection{}, InvalidPolicy
		}
		entry := TextChannelKeyRecipient{RecipientID: id, ProfileID: key.ProfileID, Kind: key.Kind,
			PublicKey: key.PublicKey, Archive: archive}
		if key.Kind == "device" {
			device := s.PolicyDevices[id]
			if device.Revoked || device.ProfileID != key.ProfileID || !signingKeyMatches(id, device.PublicKey) {
				return TextChannelKeyProjection{}, InvalidPolicy
			}
			entry.SigningKey = device.PublicKey
		}
		projection.Recipients = append(projection.Recipients, entry)
		if len(projection.Recipients) > 8192 {
			return TextChannelKeyProjection{}, ErrEpochRecipients
		}
	}
	slices.SortFunc(projection.Recipients, func(a, b TextChannelKeyRecipient) int {
		return strings.Compare(a.RecipientID, b.RecipientID)
	})
	return projection, nil
}

func (p TextChannelKeyProjection) Digest() (string, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func (s State) TextChannelKeyDigests() (map[string]string, error) {
	result := make(map[string]string)
	for id, channel := range s.Channels {
		if channel.Kind != "text" {
			continue
		}
		projection, err := s.TextChannelKeyProjection(id)
		if err != nil {
			return nil, err
		}
		digest, err := projection.Digest()
		if err != nil {
			return nil, err
		}
		result[id] = digest
	}
	return result, nil
}

func (s State) TextProjectionRoot(seedHex string) (string, error) {
	return s.textProjectionRoot(seedHex, 0)
}

func (s State) textProjectionRoot(seedHex string, version int) (string, error) {
	tree, err := s.textProjectionTree(seedHex, version)
	if err != nil {
		return "", err
	}
	return tree.root(), nil
}

func (s State) textProjectionTree(seedHex string, version int) (*channelPolicyTree, error) {
	if !isDigest(seedHex) {
		return nil, InvalidPolicy
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(seedHex)); err != nil {
		return nil, InvalidPolicy
	}
	if version == 0 {
		projections, err := s.TextChannelKeyDigests()
		if err != nil {
			return nil, err
		}
		return buildChannelPolicyTree(projections, seed)
	}
	if !HasTextRecipientProjection(version) || seed == [32]byte{} {
		return nil, InvalidPolicy
	}
	projections := make(map[string]string)
	roleRuleDigests := make(map[string]string)
	for channel, entry := range s.Channels {
		if entry.Kind != "text" && version < TextOrderAuthorityVersion {
			continue
		}
		textDigest, err := s.channelScopeRecipientDigest(channel, entry.Kind, seed, version)
		if err != nil {
			return nil, err
		}
		if version >= TextOrderAuthorityVersion {
			authority, _, err := s.channelOrderAuthority(channel, seed, "", version)
			if err != nil {
				return nil, err
			}
			textDigest = channelPolicyCombinedDigest(textDigest, authority.digest)
		}
		if version >= ProfileRoleAuthorityProjectionVersion {
			rules, err := newScopedChannelRuleTree(channel, s.scope(entry), seed)
			if err != nil {
				return nil, err
			}
			digest, err := rules.digest()
			if err != nil {
				return nil, err
			}
			roleRuleDigests[channel] = digest
			textDigest, err = scopedChannelRoleProjectionDigest(textDigest, digest)
			if err != nil {
				return nil, err
			}
		}
		projections[channel] = textDigest
	}
	var ranks *profileRankTree
	if version >= ProfileRankProjectionVersion {
		if _, exists := projections[profileRankProjectionID]; exists {
			return nil, InvalidPolicy
		}
		var err error
		ranks, err = s.profileRankCommitment(seed, version)
		if err != nil {
			return nil, err
		}
		projections[profileRankProjectionID] = ranks.digest
	}
	var inviteAdmission InviteAdmissionScopeOpening
	var roleCatalogue *scopedRoleCatalogueTree
	var roleRosters *scopedRoleRosterTree
	if version >= TextNewcomerAdmissionProjectionVersion {
		var err error
		inviteAdmission, err = s.inviteAdmissionProjection(seed)
		if err != nil {
			return nil, err
		}
		inviteAdmission.Ranks = ranks.digest
		commitment, err := inviteAdmission.digest()
		if err != nil {
			return nil, err
		}
		if version >= ProfileRoleAuthorityProjectionVersion {
			roleCatalogue, err = s.scopedRoleCatalogue(seed)
			if err != nil {
				return nil, err
			}
			roleRosters, err = s.scopedRoleRosters(seed)
			if err != nil {
				return nil, err
			}
			inviteAdmission.Catalogue = roleCatalogue.digest()
			inviteAdmission.Rosters = roleRosters.commitment.digest
			projections[profileRankProjectionID], err = roleAuxiliaryPolicyDigest(ranks.digest, commitment, roleCatalogue.digest(), roleRosters.commitment.digest)
		} else {
			projections[profileRankProjectionID], err = auxiliaryPolicyDigest(ranks.digest, commitment)
		}
		if err != nil {
			return nil, err
		}
	}
	tree, err := buildChannelPolicyTree(projections, seed)
	if err != nil {
		return nil, err
	}
	tree.ranks = ranks
	tree.inviteAdmission = inviteAdmission
	tree.roleCatalogue = roleCatalogue
	tree.roleRosters = roleRosters
	tree.roleRuleDigests = roleRuleDigests
	return tree, nil
}

func auxiliaryPolicyDigest(ranks, invites string) (string, error) {
	frame, err := SignatureFrame("pawtalk-policy-auxiliary-projection-v1", ranks, invites)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func (s State) channelScopeRecipientDigest(channel, kind string, seed [32]byte, version int) (string, error) {
	if kind == "text" {
		projection, err := s.textRecipientCommitment(channel, seed, "", version, 0)
		return projection.root, err
	}
	if kind == "voice" && version >= VoiceRecipientProjectionVersion {
		root, _, err := s.voiceRecipientCommitment(channel, seed, nil)
		return root, err
	}
	return zeroKey, nil
}
