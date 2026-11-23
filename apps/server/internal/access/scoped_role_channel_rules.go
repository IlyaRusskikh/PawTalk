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

var scopedChannelKeyPermissions = [...]string{ChannelView, "history.full", "voice.connect", "voice.speak", "message.send"}

type ScopedChannelRuleOpening struct {
	Mask uint8                `json:"mask"`
	Salt string               `json:"salt,omitempty"`
	Path []ProfileRankSibling `json:"path"`
}

type ScopedChannelRuleBasis struct {
	ChannelDigest string                 `json:"channelDigest"`
	RulesDigest   string                 `json:"rulesDigest"`
	Inclusion     ChannelPolicyInclusion `json:"inclusion"`
}

type sparsePolicyLeaf struct {
	position [32]byte
	digest   [32]byte
}

// A sparse tree stores only its nonempty branches. This keeps the proof for
// an inherited rule independent of the number and identities of other rules.
type scopedChannelRuleNode struct {
	position                [32]byte
	digest                  [32]byte
	depth                   int
	left, right             *scopedChannelRuleNode
	leftDigest, rightDigest [32]byte
}

type scopedChannelRuleTree struct {
	channelID string
	kind      string
	root      *scopedChannelRuleNode
	openings  map[[32]byte]ScopedChannelRuleOpening
}

var scopedChannelRuleEmpty = func() [257][32]byte {
	var empty [257][32]byte
	empty[256] = sha256.Sum256([]byte("pawtalk-channel-key-rule-empty-v1"))
	for depth := 255; depth >= 0; depth-- {
		empty[depth] = scopedChannelRuleBranch(empty[depth+1], empty[depth+1])
	}
	return empty
}()

func scopedChannelRuleBranch(left, right [32]byte) [32]byte {
	var frame [65]byte
	frame[0] = 1
	copy(frame[1:33], left[:])
	copy(frame[33:], right[:])
	return sha256.Sum256(frame[:])
}

func scopedChannelRulePosition(channelID, subjectKind, id string) ([32]byte, error) {
	frame, err := SignatureFrame("pawtalk-channel-key-rule-position-v1", channelID, subjectKind, id)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(frame), nil
}

func scopedChannelRuleMask(rule Overwrite) uint8 {
	var mask uint8
	factor := uint8(1)
	for _, permission := range scopedChannelKeyPermissions {
		if slices.Contains(rule.Allow, permission) {
			mask += 2 * factor
		} else if slices.Contains(rule.Deny, permission) {
			mask += factor
		}
		factor *= 3
	}
	return mask
}

func newScopedChannelRuleTree(channelID string, scope Scope, seed [32]byte) (scopedChannelRuleTree, error) {
	tree := scopedChannelRuleTree{channelID: channelID, kind: scope.Kind, openings: make(map[[32]byte]ScopedChannelRuleOpening)}
	if acl := scope.effectiveACL(); acl != nil {
		leaves := make([]sparsePolicyLeaf, 0, len(acl.Roles)+len(acl.Profiles))
		addRules := func(kind string, rules map[string]Overwrite) error {
			for id, rule := range rules {
				mask := scopedChannelRuleMask(rule)
				if mask == 0 {
					continue
				}
				position, err := scopedChannelRulePosition(channelID, kind, id)
				if err != nil {
					return err
				}
				positionHex := hex.EncodeToString(position[:])
				blind := textRecipientBlind(seed, 27, channelID, positionHex)
				salt := hex.EncodeToString(blind[:])
				frame, err := SignatureFrame("pawtalk-channel-key-rule-leaf-v1", positionHex, strconv.Itoa(int(mask)), salt)
				if err != nil {
					return err
				}
				leaves = append(leaves, sparsePolicyLeaf{position: position, digest: sha256.Sum256(frame)})
				tree.openings[position] = ScopedChannelRuleOpening{Mask: mask, Salt: salt}
			}
			return nil
		}
		if err := addRules("role", acl.Roles); err != nil {
			return tree, err
		}
		if err := addRules("profile", acl.Profiles); err != nil {
			return tree, err
		}
		var err error
		tree.root, err = buildSparsePolicyTree(leaves)
		if err != nil {
			return tree, err
		}
	}
	return tree, nil
}

func scopedChannelRuleDifference(a, b [32]byte) int {
	for index, part := range a {
		if difference := part ^ b[index]; difference != 0 {
			return index*8 + bits.LeadingZeros8(difference)
		}
	}
	return 256
}

func buildSparsePolicyTree(leaves []sparsePolicyLeaf) (*scopedChannelRuleNode, error) {
	if len(leaves) == 0 {
		return nil, nil
	}
	slices.SortFunc(leaves, func(a, b sparsePolicyLeaf) int { return bytes.Compare(a.position[:], b.position[:]) })
	return buildScopedChannelRuleNode(leaves)
}

func buildScopedChannelRuleNode(leaves []sparsePolicyLeaf) (*scopedChannelRuleNode, error) {
	first := &leaves[0]
	if len(leaves) == 1 {
		return &scopedChannelRuleNode{position: first.position, digest: first.digest, depth: 256}, nil
	}
	depth := scopedChannelRuleDifference(first.position, leaves[len(leaves)-1].position)
	if depth == 256 {
		return nil, InvalidPolicy
	}
	index := sort.Search(len(leaves), func(i int) bool { return profileRankBit(leaves[i].position, depth) })
	left, err := buildScopedChannelRuleNode(leaves[:index])
	if err != nil {
		return nil, err
	}
	right, err := buildScopedChannelRuleNode(leaves[index:])
	if err != nil {
		return nil, err
	}
	node := &scopedChannelRuleNode{position: first.position, depth: depth, left: left, right: right,
		leftDigest: left.atDepth(depth + 1), rightDigest: right.atDepth(depth + 1)}
	node.digest = scopedChannelRuleBranch(node.leftDigest, node.rightDigest)
	return node, nil
}

func (n *scopedChannelRuleNode) atDepth(target int) [32]byte {
	if n == nil {
		return scopedChannelRuleEmpty[target]
	}
	digest := n.digest
	for depth := n.depth - 1; depth >= target; depth-- {
		empty := scopedChannelRuleEmpty[depth+1]
		if profileRankBit(n.position, depth) {
			digest = scopedChannelRuleBranch(empty, digest)
		} else {
			digest = scopedChannelRuleBranch(digest, empty)
		}
	}
	return digest
}

func (t scopedChannelRuleTree) digest() (string, error) {
	root := t.root.atDepth(0)
	frame, err := SignatureFrame("pawtalk-channel-key-rules-v1", t.channelID, t.kind, hex.EncodeToString(root[:]))
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func scopedChannelRoleProjectionDigest(channelDigest, rulesDigest string) (string, error) {
	frame, err := SignatureFrame("pawtalk-channel-policy-with-key-rules-v1", channelDigest, rulesDigest)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func (s State) scopedChannelRuleBasis(channelID string, seed [32]byte, policy *channelPolicyTree) (ScopedChannelRuleBasis, scopedChannelRuleTree, error) {
	channel, ok := s.Channels[channelID]
	if !ok {
		return ScopedChannelRuleBasis{}, scopedChannelRuleTree{}, ChannelRestricted
	}
	rules, err := newScopedChannelRuleTree(channelID, s.scope(channel), seed)
	if err != nil {
		return ScopedChannelRuleBasis{}, rules, err
	}
	digest, err := rules.digest()
	if err != nil {
		return ScopedChannelRuleBasis{}, rules, err
	}
	const version = ProfileRoleAuthorityProjectionVersion
	recipients, err := s.channelScopeRecipientDigest(channelID, channel.Kind, seed, version)
	if err != nil {
		return ScopedChannelRuleBasis{}, rules, err
	}
	order, _, err := s.channelOrderAuthority(channelID, seed, "", version)
	if err != nil {
		return ScopedChannelRuleBasis{}, rules, err
	}
	inclusion, err := policy.proof(channelID)
	if err != nil {
		return ScopedChannelRuleBasis{}, rules, err
	}
	return ScopedChannelRuleBasis{ChannelDigest: channelPolicyCombinedDigest(recipients, order.digest),
		RulesDigest: digest, Inclusion: inclusion}, rules, nil
}

func (t scopedChannelRuleTree) opening(kind, id string) (ScopedChannelRuleOpening, error) {
	position, err := scopedChannelRulePosition(t.channelID, kind, id)
	if err != nil {
		return ScopedChannelRuleOpening{}, err
	}
	proof := t.openings[position]
	proof.Path = sparsePolicyOpening(t.root, position)
	return proof, nil
}

func sparsePolicyOpening(root *scopedChannelRuleNode, position [32]byte) []ProfileRankSibling {
	path := []ProfileRankSibling{}
	appendSibling := func(depth int, hash [32]byte) {
		path = append(path, ProfileRankSibling{Bit: depth, Digest: hex.EncodeToString(hash[:])})
	}
	for node := root; node != nil; {
		if firstDifference := scopedChannelRuleDifference(position, node.position); firstDifference < node.depth {
			appendSibling(firstDifference, node.atDepth(firstDifference+1))
			break
		}
		if node.depth == 256 {
			break
		}
		if profileRankBit(position, node.depth) {
			appendSibling(node.depth, node.leftDigest)
			node = node.right
		} else {
			appendSibling(node.depth, node.rightDigest)
			node = node.left
		}
	}
	return path
}
