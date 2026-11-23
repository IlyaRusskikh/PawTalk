package access

import (
	"crypto/sha256"
	"encoding/hex"
	"maps"
	"slices"
	"strconv"
)

type ScopedRoleDefinitionOpening struct {
	Rank   int                  `json:"rank"`
	Grants []string             `json:"grants"`
	Salt   string               `json:"salt"`
	Path   []ProfileRankSibling `json:"path"`
}

type scopedRoleCatalogueTree struct {
	root    *scopedChannelRuleNode
	entries map[string]ScopedRoleDefinitionOpening
}

func scopedRoleCataloguePosition(id string) ([32]byte, error) {
	frame, err := SignatureFrame("pawtalk-role-catalogue-position-v1", id)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(frame), nil
}

func (s State) scopedRoleCatalogue(seed [32]byte) (*scopedRoleCatalogueTree, error) {
	tree := &scopedRoleCatalogueTree{entries: make(map[string]ScopedRoleDefinitionOpening, len(s.Roles))}
	leaves := make([]sparsePolicyLeaf, 0, len(s.Roles))
	ranks := make(map[string]int, len(s.Roles))
	for index, role := range s.Order {
		ranks[role] = index + 1
	}
	for id, role := range s.Roles {
		position, err := scopedRoleCataloguePosition(id)
		if err != nil {
			return nil, err
		}
		blind := textRecipientBlind(seed, 28, "", id)
		entry := ScopedRoleDefinitionOpening{Rank: ranks[id], Grants: append([]string{}, slices.Sorted(maps.Keys(grantSet(role.Grants)))...),
			Salt: hex.EncodeToString(blind[:])}
		grants, err := profileRoleFieldsDigest("pawtalk-role-catalogue-grants-v1", entry.Salt, entry.Grants)
		if err != nil {
			return nil, err
		}
		frame, err := SignatureFrame("pawtalk-role-catalogue-leaf-v1", id, strconv.Itoa(entry.Rank), grants)
		if err != nil {
			return nil, err
		}
		leaves = append(leaves, sparsePolicyLeaf{position: position, digest: sha256.Sum256(frame)})
		tree.entries[id] = entry
	}
	var err error
	tree.root, err = buildSparsePolicyTree(leaves)
	return tree, err
}

func (t *scopedRoleCatalogueTree) digest() string {
	root := t.root.atDepth(0)
	return hex.EncodeToString(root[:])
}

func (t *scopedRoleCatalogueTree) opening(id string) (ScopedRoleDefinitionOpening, error) {
	entry, ok := t.entries[id]
	if !ok {
		return ScopedRoleDefinitionOpening{}, InvalidPolicy
	}
	position, err := scopedRoleCataloguePosition(id)
	if err != nil {
		return ScopedRoleDefinitionOpening{}, err
	}
	entry.Path = sparsePolicyOpening(t.root, position)
	return entry, nil
}

func roleAuxiliaryPolicyDigest(ranks, invites, catalogue, rosters string) (string, error) {
	frame, err := SignatureFrame("pawtalk-policy-auxiliary-projection-v3", ranks, invites, catalogue, rosters)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}
