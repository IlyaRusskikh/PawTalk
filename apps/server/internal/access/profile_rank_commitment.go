package access

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"math/bits"
	"slices"
	"sort"
	"strconv"
)

const ProfileRankProjectionVersion = 11
const ProfileACLBypassProjectionVersion = 12
const profileRankProjectionID = "@pawtalk-profile-ranks"

type ProfileRankSibling struct {
	Bit    int    `json:"bit"`
	Digest string `json:"digest"`
}

type ProfileRankProof struct {
	ProfileID     string               `json:"profileId"`
	Rank          int                  `json:"rank"`
	BypassesACL   *bool                `json:"bypassesACL,omitempty"`
	RoleAuthority string               `json:"roleAuthority,omitempty"`
	Salt          string               `json:"salt"`
	Path          []ProfileRankSibling `json:"path"`
}

type ChannelACLRankBasis struct {
	Root      string                 `json:"root"`
	Invites   string                 `json:"invites,omitempty"`
	Catalogue string                 `json:"catalogue,omitempty"`
	Rosters   string                 `json:"rosters,omitempty"`
	Inclusion ChannelPolicyInclusion `json:"inclusion"`
	Actor     ProfileRankProof       `json:"actor"`
	Target    ProfileRankProof       `json:"target"`
}

type profileRankLeaf struct {
	profileID     string
	rank          int
	bypassesACL   bool
	roleAuthority string
	salt          string
	position      [32]byte
	digest        [32]byte
}

type profileRankNode struct {
	digest      [32]byte
	bit         int
	left, right *profileRankNode
	leaf        *profileRankLeaf
}

type profileRankTree struct {
	root              *profileRankNode
	digest            string
	leaves            map[string]profileRankLeaf
	includesACLBypass bool
}

func (s State) profileRankCommitment(seed [32]byte, version int) (*profileRankTree, error) {
	tree := &profileRankTree{leaves: make(map[string]profileRankLeaf), includesACLBypass: version >= ProfileACLBypassProjectionVersion}
	var keys map[string][]ProfileRoleKey
	if version >= ProfileRoleAuthorityProjectionVersion {
		keys = scopedRoleKeys(s)
	}
	var leaves []profileRankLeaf
	for id, subject := range s.Members {
		if !subject.Active || s.ProfileBindings[id] != "" {
			continue
		}
		if !isDigest(id) || subject.ID != id {
			return nil, InvalidPolicy
		}
		salt := textRecipientBlind(seed, 13, profileRankProjectionID, id)
		leaf := profileRankLeaf{profileID: id, rank: s.rank(subject), salt: hex.EncodeToString(salt[:])}
		position, err := SignatureFrame("pawtalk-policy-profile-rank-position-v1", id, leaf.salt)
		if err != nil {
			return nil, err
		}
		rank := strconv.Itoa(leaf.rank)
		fields := []string{"pawtalk-policy-profile-rank-leaf-v1", id, rank, leaf.salt}
		if tree.includesACLBypass {
			leaf.bypassesACL = s.owner(subject) || s.baseGrant(subject, Administrator)
			fields = []string{"pawtalk-policy-profile-rank-leaf-v2", id, rank, strconv.FormatBool(leaf.bypassesACL), leaf.salt}
		}
		if version >= ProfileRoleAuthorityProjectionVersion {
			leaf.roleAuthority, err = s.profileRoleAuthority(seed, subject, keys[id]).digest()
			if err != nil {
				return nil, err
			}
			fields = []string{"pawtalk-policy-profile-rank-leaf-v3", id, rank, strconv.FormatBool(leaf.bypassesACL), leaf.salt, leaf.roleAuthority}
		}
		frame, err := SignatureFrame(fields...)
		if err != nil {
			return nil, err
		}
		leaf.position, leaf.digest = sha256.Sum256(position), sha256.Sum256(frame)
		tree.leaves[id] = leaf
		leaves = append(leaves, leaf)
	}
	if len(leaves) == 0 {
		frame, err := SignatureFrame("pawtalk-policy-profile-rank-empty-v1")
		if err != nil {
			return nil, err
		}
		tree.digest = hexHash(frame)
		return tree, nil
	}
	slices.SortFunc(leaves, func(a, b profileRankLeaf) int { return bytes.Compare(a.position[:], b.position[:]) })
	var err error
	tree.root, err = buildProfileRankTrie(leaves)
	if err != nil {
		return nil, err
	}
	tree.digest = hex.EncodeToString(tree.root.digest[:])
	return tree, nil
}

func buildProfileRankTrie(leaves []profileRankLeaf) (*profileRankNode, error) {
	first := &leaves[0]
	if len(leaves) == 1 {
		return &profileRankNode{digest: first.digest, leaf: first}, nil
	}
	last := &leaves[len(leaves)-1]
	for i, value := range first.position {
		if difference := value ^ last.position[i]; difference != 0 {
			bit := 8*i + bits.LeadingZeros8(difference)
			at := sort.Search(len(leaves), func(index int) bool { return profileRankBit(leaves[index].position, bit) })
			left, err := buildProfileRankTrie(leaves[:at])
			if err != nil {
				return nil, err
			}
			right, err := buildProfileRankTrie(leaves[at:])
			if err != nil {
				return nil, err
			}
			var branch [66]byte
			branch[0], branch[1] = 1, byte(bit)
			copy(branch[2:34], left.digest[:])
			copy(branch[34:], right.digest[:])
			return &profileRankNode{digest: sha256.Sum256(branch[:]), bit: bit, left: left, right: right}, nil
		}
	}
	return nil, InvalidPolicy
}

func profileRankBit(position [32]byte, bit int) bool {
	return position[bit/8]&(0x80>>uint(bit%8)) != 0
}

func (t *profileRankTree) proof(id string) (ProfileRankProof, error) {
	leaf, ok := t.leaves[id]
	if !ok {
		return ProfileRankProof{}, ChannelRestricted
	}
	proof := ProfileRankProof{ProfileID: id, Rank: leaf.rank, Salt: leaf.salt, RoleAuthority: leaf.roleAuthority, Path: []ProfileRankSibling{}}
	if t.includesACLBypass {
		proof.BypassesACL = &leaf.bypassesACL
	}
	node := t.root
	for node.leaf == nil {
		next, sibling := node.left, node.right
		if profileRankBit(leaf.position, node.bit) {
			next, sibling = sibling, next
		}
		proof.Path = append(proof.Path, ProfileRankSibling{Bit: node.bit, Digest: hex.EncodeToString(sibling.digest[:])})
		node = next
	}
	if node.leaf.profileID != id {
		return ProfileRankProof{}, ErrPolicyConflict
	}
	return proof, nil
}
