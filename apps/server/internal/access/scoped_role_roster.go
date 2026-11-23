package access

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"slices"
)

type scopedRoleRosterTree struct {
	commitment *profileRankTree
	channels   map[string]*profileRankTree
}

type scopedRoleRosterOpening struct {
	Root        string               `json:"root"`
	ChannelPath []ProfileRankSibling `json:"channelPath"`
	Actor       rosterMemberOpening  `json:"actor"`
	Target      rosterMemberOpening  `json:"target"`
}

type rosterMemberOpening struct {
	Salt string               `json:"salt"`
	Path []ProfileRankSibling `json:"path"`
}

func scopedRoleRosterAlias(seed [32]byte, channel string) (alias, salt string) {
	blind := textRecipientBlind(seed, 30, channel, "")
	salt = hex.EncodeToString(blind[:])
	frame, _ := SignatureFrame("pawtalk-role-roster-alias-v1", channel, salt)
	return hexHash(frame), salt
}

func rosterLeaf(domain, id string, fields ...string) profileRankLeaf {
	position, _ := SignatureFrame("pawtalk-role-roster-position-v1", domain, id)
	frame, _ := SignatureFrame(append([]string{domain, id}, fields...)...)
	return profileRankLeaf{profileID: id, position: sha256.Sum256(position), digest: sha256.Sum256(frame)}
}

func newRoleRosterTrie(leaves []profileRankLeaf) (*profileRankTree, error) {
	result := &profileRankTree{leaves: make(map[string]profileRankLeaf, len(leaves))}
	if len(leaves) == 0 {
		frame, _ := SignatureFrame("pawtalk-role-roster-empty-v1")
		result.digest = hexHash(frame)
		return result, nil
	}
	for _, leaf := range leaves {
		result.leaves[leaf.profileID] = leaf
	}
	slices.SortFunc(leaves, func(a, b profileRankLeaf) int { return bytes.Compare(a.position[:], b.position[:]) })
	var err error
	result.root, err = buildProfileRankTrie(leaves)
	if err != nil {
		return nil, err
	}
	result.digest = hex.EncodeToString(result.root.digest[:])
	return result, nil
}

func (s State) scopedRoleRosters(seed [32]byte) (*scopedRoleRosterTree, error) {
	result := &scopedRoleRosterTree{channels: make(map[string]*profileRankTree)}
	var channels []profileRankLeaf
	for channel, entry := range s.Channels {
		if entry.Kind != "text" {
			continue
		}
		alias, _ := scopedRoleRosterAlias(seed, channel)
		var members []profileRankLeaf
		for id, member := range s.Members {
			if !member.Active || s.ProfileBindings[id] != "" || !s.CanDeliver(id, channel, 0) {
				continue
			}
			blind := textRecipientBlind(seed, 31, channel, id)
			salt := hex.EncodeToString(blind[:])
			// The per-member salt also hides the trie position from observers.
			memberID, _ := SignatureFrame(alias, id, salt)
			leaf := rosterLeaf("pawtalk-role-roster-member-v1", hexHash(memberID), alias, id, salt)
			leaf.profileID, leaf.salt = id, salt
			members = append(members, leaf)
		}
		tree, err := newRoleRosterTrie(members)
		if err != nil {
			return nil, err
		}
		result.channels[alias] = tree
		channels = append(channels, rosterLeaf("pawtalk-role-roster-channel-v1", alias, tree.digest))
	}
	var err error
	result.commitment, err = newRoleRosterTrie(channels)
	return result, err
}

func (t *scopedRoleRosterTree) opening(alias, actor, target string) (*scopedRoleRosterOpening, error) {
	tree := t.channels[alias]
	if tree == nil || actor == target {
		return nil, ChannelRestricted
	}
	channelProof, err := t.commitment.proof(alias)
	if err != nil {
		return nil, err
	}
	actorProof, err := tree.proof(actor)
	if err != nil {
		return nil, err
	}
	targetProof, err := tree.proof(target)
	if err != nil {
		return nil, err
	}
	return &scopedRoleRosterOpening{Root: tree.digest, ChannelPath: channelProof.Path,
		Actor:  rosterMemberOpening{Salt: actorProof.Salt, Path: actorProof.Path},
		Target: rosterMemberOpening{Salt: targetProof.Salt, Path: targetProof.Path}}, nil
}
