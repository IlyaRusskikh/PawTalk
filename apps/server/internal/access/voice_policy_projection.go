package access

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"slices"
)

const VoiceRecipientProjectionVersion = 8

type VoiceRecipientInclusion struct {
	DeviceID   string            `json:"deviceId"`
	SigningKey string            `json:"signingKey"`
	Salt       string            `json:"salt"`
	Proof      EpochPackageProof `json:"proof"`
}

type VoiceChannelPolicyDisclosure struct {
	Inclusion       ChannelPolicyInclusion    `json:"inclusion"`
	OrderDigest     string                    `json:"orderDigest"`
	RoleRulesDigest string                    `json:"roleRulesDigest,omitempty"`
	Recipients      []VoiceRecipientInclusion `json:"recipients"`
}

type voiceRecipientLeaf struct {
	device, profile, agreementKey, signingKey string
	salt, rank, hash                          [32]byte
}

func (s State) voiceRecipientCommitment(channelID string, seed [32]byte, roster []VoiceKeyRecipient) (string, []VoiceRecipientInclusion, error) {
	channel, exists := s.Channels[channelID]
	if !exists || channel.Kind != "voice" {
		return "", nil, ChannelRestricted
	}
	scope := s.scope(channel)
	leaves := make([]voiceRecipientLeaf, 0)
	for id, recipient := range s.KeyRecipients {
		device := s.PolicyDevices[id]
		if recipient.Kind != "device" || device.Revoked || device.ProfileID == "" || device.ProfileID != recipient.ProfileID {
			continue
		}
		subject := s.Members[device.ProfileID]
		// A time-out is enforced on current sessions. The signed commitment
		// stays valid when its clock-based deadline passes.
		subject.TimeoutUntil = 0
		if s.excludedFromVoiceKeys(channelID, subject.ID) || s.CheckGrant(subject, scope, "voice.connect", 0) != Allowed {
			continue
		}
		if len(leaves) == 8192 || !isDigest(device.ProfileID) || !isDigest(recipient.PublicKey) || !signingKeyMatches(id, device.PublicKey) {
			return "", nil, InvalidPolicy
		}
		leaf := voiceRecipientLeaf{device: id, profile: device.ProfileID, agreementKey: recipient.PublicKey,
			signingKey: device.PublicKey, salt: textRecipientBlind(seed, 8, channelID, id), rank: textRecipientBlind(seed, 9, channelID, id)}
		frame, err := SignatureFrame("pawtalk-voice-recipient-v1", id, leaf.profile, leaf.agreementKey, leaf.signingKey, hex.EncodeToString(leaf.salt[:]))
		if err != nil {
			return "", nil, err
		}
		leaf.hash = sha256.Sum256(frame)
		leaves = append(leaves, leaf)
	}
	slices.SortFunc(leaves, func(a, b voiceRecipientLeaf) int {
		if rank := bytes.Compare(a.rank[:], b.rank[:]); rank != 0 {
			return rank
		}
		return bytes.Compare(a.hash[:], b.hash[:])
	})
	hashes := make([][32]byte, len(leaves))
	for i, leaf := range leaves {
		hashes[i] = leaf.hash
	}
	if len(roster) == 0 {
		root, _ := foldCommitmentLeaves(hashes, -1)
		return root, nil, nil
	}
	positions := make(map[string]int, len(leaves))
	for i, leaf := range leaves {
		positions[leaf.device] = i
	}
	levels := voiceRecipientLevels(hashes)
	proofs := make([]VoiceRecipientInclusion, 0, len(roster))
	seen := make(map[string]bool, len(roster))
	for _, member := range roster {
		index, present := positions[member.DeviceID]
		if !present || seen[member.DeviceID] {
			return "", nil, ErrEpochRecipients
		}
		seen[member.DeviceID] = true
		leaf := leaves[index]
		if leaf.profile != member.ProfileID || leaf.agreementKey != member.PublicKey {
			return "", nil, ErrEpochRecipients
		}
		proof := EpochPackageProof{Index: index, Count: len(leaves), Siblings: make([]string, 0, len(levels)-1)}
		for _, level := range levels[:len(levels)-1] {
			if sibling := index ^ 1; sibling < len(level) {
				proof.Siblings = append(proof.Siblings, hex.EncodeToString(level[sibling][:]))
			}
			index /= 2
		}
		proofs = append(proofs, VoiceRecipientInclusion{DeviceID: leaf.device, SigningKey: leaf.signingKey, Salt: hex.EncodeToString(leaf.salt[:]), Proof: proof})
	}
	return countedCommitmentRoot(len(leaves), levels[len(levels)-1][0]), proofs, nil
}

func voiceRecipientLevels(level [][32]byte) [][][32]byte {
	levels := [][][32]byte{level}
	for len(level) > 1 {
		parent := make([][32]byte, (len(level)+1)/2)
		for i := 0; i+1 < len(level); i += 2 {
			parent[i/2] = commitmentParent(level[i], level[i+1])
		}
		if len(level)%2 != 0 {
			parent[len(parent)-1] = level[len(level)-1]
		}
		level = parent
		levels = append(levels, level)
	}
	return levels
}

// ReadVoiceChannelPolicy proves eligibility only for the supplied active
// roster. The caller loads that roster and basis from the same transaction.
func ReadVoiceChannelPolicy(ctx context.Context, query SessionQuery, head PolicyProof, channel string,
	roster []VoiceKeyRecipient, cache *TextChannelPolicyProofCache) (*VoiceChannelPolicyDisclosure, error) {
	if head.Draft.TextProjectionVersion < VoiceRecipientProjectionVersion {
		return nil, nil
	}
	state, revision, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return nil, err
	}
	if err := checkPolicyHead(state, revision, head); err != nil {
		return nil, err
	}
	return voiceChannelPolicyDisclosure(state, head, channel, roster, &cache.current)
}

func voiceChannelPolicyDisclosure(state State, head PolicyProof, channel string, roster []VoiceKeyRecipient,
	cache *textChannelPolicyTreeCache) (*VoiceChannelPolicyDisclosure, error) {
	var seed [32]byte
	if !isDigest(head.Draft.TextProjectionSeed) {
		return nil, ErrPolicyConflict
	}
	if _, err := hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	_, proofs, err := state.voiceRecipientCommitment(channel, seed, roster)
	if err != nil {
		return nil, err
	}
	order, _, err := state.channelOrderAuthority(channel, seed, "", head.Draft.TextProjectionVersion)
	if err != nil {
		return nil, err
	}
	inclusion, roleRulesDigest, err := cache.inclusionWithRoleRules(state, head, channel)
	if err != nil {
		return nil, err
	}
	return &VoiceChannelPolicyDisclosure{Inclusion: inclusion, OrderDigest: order.digest, Recipients: proofs, RoleRulesDigest: roleRulesDigest}, nil
}
