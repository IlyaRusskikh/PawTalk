package access

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"slices"
	"unicode/utf8"
)

// Channel policy disclosures use a fixed tree of 1024 positions. Both real
// entries and padding are independently blinded and ordered by a keyed rank.
// A proof reveals neither the padding boundary nor a channel count.
const channelPolicyDepth = 10
const channelPolicySlots = 1 << channelPolicyDepth

type ChannelPolicyInclusion struct {
	Index    int      `json:"index"`
	Salt     string   `json:"salt"`
	Siblings []string `json:"siblings"`
}

type channelPolicyLeaf struct {
	id   string
	rank [32]byte
	salt [32]byte
	hash [32]byte
}
type channelPolicyPosition struct {
	index int
	salt  [32]byte
}
type channelPolicyTree struct {
	positions       map[string]channelPolicyPosition
	levels          [][][32]byte
	ranks           *profileRankTree
	inviteAdmission InviteAdmissionScopeOpening
	roleCatalogue   *scopedRoleCatalogueTree
	roleRosters     *scopedRoleRosterTree
	roleRuleDigests map[string]string
}

// ChannelPolicyCommitment accepts digests of the canonical per-channel
// projections. The signing client recomputes the root with the same seed.
// A recipient obtains its proof and projection without learning the seed.
func ChannelPolicyCommitment(projections map[string]string, seed [32]byte, selected string) (string, ChannelPolicyInclusion, error) {
	tree, err := buildChannelPolicyTree(projections, seed)
	if err != nil {
		return "", ChannelPolicyInclusion{}, err
	}
	if selected == "" {
		return tree.root(), ChannelPolicyInclusion{}, nil
	}
	proof, err := tree.proof(selected)
	return tree.root(), proof, err
}

func buildChannelPolicyTree(projections map[string]string, seed [32]byte) (*channelPolicyTree, error) {
	if len(projections) > channelPolicySlots || seed == [32]byte{} {
		return nil, InvalidPolicy
	}
	leaves := make([]channelPolicyLeaf, 0, channelPolicySlots)
	for id, digest := range projections {
		if len(id) == 0 || len(id) > 64 || !utf8.ValidString(id) || !isDigest(digest) {
			return nil, InvalidPolicy
		}
		idHash := sha256.Sum256([]byte(id))
		salt := channelPolicyBlind(seed, 0, idHash[:])
		rank := channelPolicyBlind(seed, 1, idHash[:])
		var material [97]byte
		copy(material[1:33], idHash[:])
		copy(material[33:65], salt[:])
		if _, err := hex.Decode(material[65:], []byte(digest)); err != nil {
			return nil, InvalidPolicy
		}
		leaves = append(leaves, channelPolicyLeaf{id: id, rank: rank, salt: salt, hash: sha256.Sum256(material[:])})
	}
	for i := 0; len(leaves) < channelPolicySlots; i++ {
		var index [2]byte
		binary.BigEndian.PutUint16(index[:], uint16(i))
		leaf := channelPolicyBlind(seed, 2, index[:])
		rank := channelPolicyBlind(seed, 3, index[:])
		leaves = append(leaves, channelPolicyLeaf{rank: rank, hash: leaf})
	}
	slices.SortFunc(leaves, func(a, b channelPolicyLeaf) int {
		if rank := bytes.Compare(a.rank[:], b.rank[:]); rank != 0 {
			return rank
		}
		return bytes.Compare(a.hash[:], b.hash[:])
	})
	level := make([][32]byte, len(leaves))
	tree := &channelPolicyTree{positions: make(map[string]channelPolicyPosition, len(projections)),
		levels: make([][][32]byte, 0, channelPolicyDepth+1)}
	for i, leaf := range leaves {
		level[i] = leaf.hash
		if leaf.id != "" {
			tree.positions[leaf.id] = channelPolicyPosition{index: i, salt: leaf.salt}
		}
	}
	tree.levels = append(tree.levels, level)
	for len(level) > 1 {
		parent := make([][32]byte, len(level)/2)
		for i := range parent {
			var pair [65]byte
			pair[0] = 1
			copy(pair[1:33], level[i*2][:])
			copy(pair[33:], level[i*2+1][:])
			parent[i] = sha256.Sum256(pair[:])
		}
		level = parent
		tree.levels = append(tree.levels, level)
	}
	return tree, nil
}

func (t *channelPolicyTree) root() string {
	return hex.EncodeToString(t.levels[channelPolicyDepth][0][:])
}

func (t *channelPolicyTree) proof(channel string) (ChannelPolicyInclusion, error) {
	position, ok := t.positions[channel]
	if !ok {
		return ChannelPolicyInclusion{}, ChannelRestricted
	}
	index := position.index
	proof := ChannelPolicyInclusion{Index: index, Salt: hex.EncodeToString(position.salt[:]), Siblings: make([]string, channelPolicyDepth)}
	for i := range proof.Siblings {
		proof.Siblings[i] = hex.EncodeToString(t.levels[i][index^1][:])
		index /= 2
	}
	return proof, nil
}

func channelPolicyBlind(seed [32]byte, mode byte, data []byte) [32]byte {
	mac := hmac.New(sha256.New, seed[:])
	mac.Write([]byte("pawtalk-channel-policy-commitment-v1"))
	mac.Write([]byte{mode})
	mac.Write(data)
	var value [32]byte
	mac.Sum(value[:0])
	return value
}
