package access

import (
	"slices"
	"strconv"
)

const MaxScopeOwnershipCandidates = 8192

type ScopeOwnershipClaim struct {
	CutoverDigest  string   `json:"cutoverDigest"`
	ExpiresAt      int64    `json:"expiresAt"`
	CandidatesRoot string   `json:"candidatesRoot"`
	Index          int      `json:"index"`
	Count          int      `json:"count"`
	Siblings       []string `json:"siblings"`
}

func ownershipCandidateHash(fields ...string) string {
	frame, err := SignatureFrame(fields...)
	if err != nil {
		return ""
	}
	return hexHash(frame)
}

func ownershipCandidateTree(keys []string) ([]string, []string, error) {
	if len(keys) == 0 || len(keys) > MaxScopeOwnershipCandidates {
		return nil, nil, ErrScopeAuthority
	}
	ordered := slices.Clone(keys)
	slices.Sort(ordered)
	leaves := make([]string, len(ordered))
	for index, key := range ordered {
		if (index > 0 && ordered[index-1] == key) || parseScopeAuthorityKey(key) == nil {
			return nil, nil, ErrScopeAuthority
		}
		leaves[index] = ownershipCandidateHash("pawtalk-owner-transfer-candidate-v1", key)
	}
	return ordered, leaves, nil
}

func ownershipCandidateParent(left, right string) string {
	return ownershipCandidateHash("pawtalk-owner-transfer-node-v1", left, right)
}

func ownershipCandidateRoot(count int, tree string) string {
	return ownershipCandidateHash("pawtalk-owner-transfer-root-v1", strconv.Itoa(count), tree)
}

func foldOwnershipCandidates(level []string) []string {
	parents := make([]string, (len(level)+1)/2)
	for index := range parents {
		left := 2 * index
		parents[index] = ownershipCandidateParent(level[left], level[min(left+1, len(level)-1)])
	}
	return parents
}

func ScopeOwnershipCandidatesRoot(keys []string) (string, error) {
	ordered, level, err := ownershipCandidateTree(keys)
	if err != nil {
		return "", err
	}
	for len(level) > 1 {
		level = foldOwnershipCandidates(level)
	}
	return ownershipCandidateRoot(len(ordered), level[0]), nil
}

func ScopeOwnershipCandidateClaim(keys []string, selectedKey string, expiresAt int64) (ScopeOwnershipClaim, error) {
	ordered, level, err := ownershipCandidateTree(keys)
	if err != nil || expiresAt < 1 || expiresAt > maxInviteDate {
		return ScopeOwnershipClaim{}, ErrScopeAuthority
	}
	index, found := slices.BinarySearch(ordered, selectedKey)
	if !found {
		return ScopeOwnershipClaim{}, ErrScopeAuthority
	}
	claim := ScopeOwnershipClaim{ExpiresAt: expiresAt, Index: index, Count: len(ordered), Siblings: []string{}}
	for len(level) > 1 {
		claim.Siblings = append(claim.Siblings, level[min(index^1, len(level)-1)])
		index /= 2
		level = foldOwnershipCandidates(level)
	}
	claim.CandidatesRoot = ownershipCandidateRoot(claim.Count, level[0])
	return claim, nil
}

func (claim ScopeOwnershipClaim) proves(key string) bool {
	if claim.Count < 1 || claim.Count > MaxScopeOwnershipCandidates || claim.Index < 0 || claim.Index >= claim.Count ||
		claim.Siblings == nil || len(claim.Siblings) > 16 || !isDigest(claim.CandidatesRoot) || !isDigest(key) {
		return false
	}
	value := ownershipCandidateHash("pawtalk-owner-transfer-candidate-v1", key)
	width, index := claim.Count, claim.Index
	for _, sibling := range claim.Siblings {
		if width <= 1 || !isDigest(sibling) || (index^1 >= width && value != sibling) {
			return false
		}
		if index%2 == 0 {
			value = ownershipCandidateParent(value, sibling)
		} else {
			value = ownershipCandidateParent(sibling, value)
		}
		width, index = (width+1)/2, index/2
	}
	return width == 1 && ownershipCandidateRoot(claim.Count, value) == claim.CandidatesRoot
}
