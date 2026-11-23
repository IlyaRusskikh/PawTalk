package access

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"maps"
	"slices"
)

const maxRoleViewDenyWitness = 8192

type RoleViewDenyEffectProof struct {
	RoleID              string            `json:"roleId"`
	Salt                string            `json:"salt"`
	PreviousRulesDigest string            `json:"previousRulesDigest"`
	NextRulesDigest     string            `json:"nextRulesDigest"`
	ExcludedProfiles    []string          `json:"excludedProfiles"`
	Proof               EpochPackageProof `json:"proof"`
}

func roleViewDenyRules(previous map[string]Overwrite, role string) map[string]Overwrite {
	next := maps.Clone(previous)
	rule := next[role]
	rule.Allow = slices.DeleteFunc(slices.Clone(rule.Allow), func(permission string) bool { return permission == ChannelView })
	if len(rule.Allow) == 0 {
		rule.Allow = nil
	}
	rule.Deny = append(slices.Clone(rule.Deny), ChannelView)
	next[role] = rule
	return next
}

func roleViewDenyProfilesDigest(profiles []string) (string, error) {
	digest := sha256.New()
	digest.Write([]byte("pawtalk-role-view-deny-profiles-v1:"))
	previous := ""
	for _, profile := range profiles {
		if !isDigest(profile) || profile <= previous {
			return "", InvalidPolicy
		}
		decoded, _ := hex.DecodeString(profile)
		digest.Write(decoded)
		previous = profile
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// A single named-role deny can only remove view. An overriding personal
// Allow or an Allow from another named role preserves it.
func (s State) roleViewDenyExclusions(scope Scope, rules map[string]Overwrite) map[string][]string {
	exclusions := make(map[string][]string)
	profiles := scope.effectiveACL().Profiles
	for _, subject := range s.Members {
		if s.owner(subject) || s.baseGrant(subject, Administrator) ||
			slices.Contains(profiles[subject.ID].Allow, ChannelView) || s.CheckGrant(subject, scope, ChannelView, 0) != Allowed {
			continue
		}
		var allowedRole string
		var multipleAllows bool
		for _, role := range subject.Roles {
			if role != Everyone && slices.Contains(rules[role].Allow, ChannelView) {
				if allowedRole != "" && allowedRole != role {
					multipleAllows = true
					break
				}
				allowedRole = role
			}
		}
		if multipleAllows {
			continue
		}
		for _, role := range subject.Roles {
			if role == Everyone || allowedRole != "" && role != allowedRole || slices.Contains(rules[role].Deny, ChannelView) {
				continue
			}
			affected := exclusions[role]
			if len(affected) == 0 || affected[len(affected)-1] != subject.ID {
				exclusions[role] = append(affected, subject.ID)
			}
		}
	}
	return exclusions
}

func (s State) roleViewDenyCommitment(channel string, seed [32]byte, selectedNextRulesDigest string) (string, *RoleViewDenyEffectProof, error) {
	scope := s.scope(s.Channels[channel])
	rules := scopedACLRoleRules(scope)
	previousDigest, err := channelACLRoleRulesDigest(rules)
	if err != nil {
		return "", nil, err
	}
	exclusions := s.roleViewDenyExclusions(scope, rules)
	leaves := make([][32]byte, 0, len(exclusions))
	var selectedLeaf [32]byte
	var witness *RoleViewDenyEffectProof
	for role, excluded := range exclusions {
		slices.Sort(excluded)
		profilesDigest, err := roleViewDenyProfilesDigest(excluded)
		if err != nil {
			return "", nil, err
		}
		nextDigest, err := channelACLRoleRulesDigest(roleViewDenyRules(rules, role))
		if err != nil {
			return "", nil, err
		}
		rawSalt := textRecipientBlind(seed, 21, channel, role)
		salt := hex.EncodeToString(rawSalt[:])
		frame, err := SignatureFrame("pawtalk-role-view-deny-effect-v1", role, salt, previousDigest, nextDigest, profilesDigest)
		if err != nil {
			return "", nil, err
		}
		leaf := sha256.Sum256(frame)
		leaves = append(leaves, leaf)
		if nextDigest == selectedNextRulesDigest && len(excluded) <= maxRoleViewDenyWitness && len(exclusions) <= maxRoleViewDenyWitness {
			selectedLeaf = leaf
			witness = &RoleViewDenyEffectProof{RoleID: role, Salt: salt, PreviousRulesDigest: previousDigest,
				NextRulesDigest: nextDigest, ExcludedProfiles: excluded}
		}
	}
	slices.SortFunc(leaves, func(a, b [32]byte) int { return bytes.Compare(a[:], b[:]) })
	index := -1
	if witness != nil {
		index = slices.Index(leaves, selectedLeaf)
	}
	count := len(leaves)
	root, siblings := foldCommitmentLeaves(leaves, index)
	if witness != nil {
		witness.Proof = EpochPackageProof{Index: index, Count: count, Siblings: siblings}
	}
	return root, witness, nil
}
