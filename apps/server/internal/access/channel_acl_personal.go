package access

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"slices"
	"strconv"
)

const EditScopedChannelACLPersonal = "channel.acl.personal.scoped"

var ErrChannelACLPersonalEditProof = errors.New("invalid protected channel personal ACL editor proof")

type PolicyChannelACLPersonalEdit struct {
	CutoverDigest string
	Permission    string
	Rule          string
	EditorProof   string
	ServerKey     string
}

type ChannelACLPersonalDisclosure struct {
	ChannelID  string               `json:"channelId"`
	ProfileID  string               `json:"profileId"`
	Revision   int64                `json:"revision"`
	PolicyHead string               `json:"policyHead"`
	Rules      *Overwrite           `json:"rules"`
	RankBasis  *ChannelACLRankBasis `json:"rankBasis,omitempty"`
}

func (s State) checkScopedChannelACLTarget(actor Principal, channelID, targetID string) (Channel, *Overwrite, error) {
	channel, err := s.checkScopedChannelACLAccess(actor, channelID)
	if err != nil {
		return Channel{}, nil, err
	}
	scope := s.scope(channel)
	target, exists := s.Members[targetID]
	subject := s.Members[actor.ProfileID]
	if !exists || !target.Active || s.owner(target) ||
		s.CheckAction(subject, target, scope, channelACLPermission, false, 0) != Allowed {
		return Channel{}, nil, ChannelRestricted
	}
	mayDiscover := s.CanDeliver(targetID, channelID, 0) || s.CheckGrant(subject, Scope{}, "member.list", 0) == Allowed
	var current *Overwrite
	if acl := scope.effectiveACL(); acl != nil {
		if rule, exists := acl.Profiles[targetID]; exists {
			local := channelRules(ACL{Profiles: map[string]Overwrite{targetID: rule}}, channel.Kind)
			if rule, exists := local.Profiles[targetID]; exists {
				current = &rule
			}
		}
	}
	if !mayDiscover && current == nil {
		return Channel{}, nil, ChannelRestricted
	}
	return channel, current, nil
}

func (s State) checkScopedChannelACLPersonal(actor Principal, draft PolicyDraft, head PolicyProof) (Channel, Overwrite, error) {
	change := draft.ResourceChange
	if draft.Action != EditScopedChannelACLPersonal || change == nil || change.ACLPersonalEdit == nil ||
		*change != (PolicyResourceChange{ID: change.ID, TargetProfileID: change.TargetProfileID, ACLPersonalEdit: change.ACLPersonalEdit}) ||
		!validRotationID(change.ID) || !isDigest(change.TargetProfileID) {
		return Channel{}, Overwrite{}, InvalidAction
	}
	intent := change.ACLPersonalEdit
	if !isDigest(intent.CutoverDigest) || !validRecoveryProof(intent.EditorProof, ed25519.SignatureSize) ||
		!validRecoveryProof(intent.ServerKey, ed25519.PublicKeySize) ||
		(intent.Rule != "allow" && intent.Rule != "deny" && intent.Rule != "inherit") {
		return Channel{}, Overwrite{}, InvalidAction
	}
	if head.Draft.TextProjectionVersion < ChannelACLProjectionVersion {
		return Channel{}, Overwrite{}, ErrPolicyAttestationUnavailable
	}
	channel, current, err := s.checkScopedChannelACLTarget(actor, change.ID, change.TargetProfileID)
	if err != nil {
		return Channel{}, Overwrite{}, err
	}
	permission, exists := permissions[intent.Permission]
	if !exists || !fitsScope(permission.Scope, channel.Kind) {
		return Channel{}, Overwrite{}, InvalidPolicy
	}
	previous := "inherit"
	var rule Overwrite
	if current != nil {
		rule = *current
		if slices.Contains(rule.Allow, intent.Permission) {
			previous = "allow"
		} else if slices.Contains(rule.Deny, intent.Permission) {
			previous = "deny"
		}
	}
	if previous == intent.Rule {
		return Channel{}, Overwrite{}, InvalidAction
	}
	remove := func(values []string) []string {
		next := slices.DeleteFunc(slices.Clone(values), func(value string) bool { return value == intent.Permission })
		if len(values) != 0 && len(next) == 0 {
			return nil
		}
		return next
	}
	rule.Allow, rule.Deny = remove(rule.Allow), remove(rule.Deny)
	switch intent.Rule {
	case "allow":
		rule.Allow = append(rule.Allow, intent.Permission)
	case "deny":
		rule.Deny = append(rule.Deny, intent.Permission)
	}
	return channel, rule, nil
}

func (s *State) applyScopedChannelACLPersonal(actor Principal, draft PolicyDraft, head PolicyProof) error {
	channel, rule, err := s.checkScopedChannelACLPersonal(actor, draft, head)
	if err != nil {
		return err
	}
	scope := s.scope(channel)
	acl := channelRules(*scope.effectiveACL(), channel.Kind)
	change := draft.ResourceChange
	if len(rule.Allow)+len(rule.Deny) == 0 {
		delete(acl.Profiles, change.TargetProfileID)
	} else {
		acl.Profiles[change.TargetProfileID] = rule
	}
	return s.setChannelACL(actor.ProfileID, change.ID, acl)
}

func VerifyScopedChannelACLPersonalEdit(ctx context.Context, query SessionQuery, serverID string, actor Principal, draft PolicyDraft) error {
	state, head, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return err
	}
	channel, _, err := state.checkScopedChannelACLPersonal(actor, draft, head)
	if err != nil {
		return err
	}
	change := draft.ResourceChange
	intent := change.ACLPersonalEdit
	frame, err := SignatureFrame("pawtalk-protected-channel-acl-personal-edit-v1", serverID, intent.CutoverDigest,
		actor.ProfileID, actor.DeviceID, draft.OperationID, strconv.FormatInt(head.Draft.Revision, 10), head.Digest,
		change.ID, channel.Kind, channel.CategoryID, change.TargetProfileID, intent.Permission, intent.Rule)
	if err != nil {
		return err
	}
	key := state.PolicyDevices[actor.DeviceID].PublicKey
	if !signingKeyMatches(actor.DeviceID, key) || !verifyScopeAuthoritySignature(parseScopeAuthorityKey(key), frame, intent.EditorProof) {
		return ErrChannelACLPersonalEditProof
	}
	return nil
}

func (s *Store) CommitScopedChannelACLPersonalEdit(ctx context.Context, resolve ResolveSession, intent PolicyDraft,
	sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	if intent.Action != EditScopedChannelACLPersonal {
		return PolicyProof{}, InvalidAction
	}
	return s.commitScopedChannelACLIntent(ctx, resolve, intent, sign, verify)
}

func (s *Store) DispatchChannelACLPersonal(ctx context.Context, resolve ResolveSession, channelID, profileID string,
	cache *TextChannelPolicyProofCache, deliver func(ChannelACLPersonalDisclosure) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		_, rules, err := state.checkScopedChannelACLTarget(actor, channelID, profileID)
		if err != nil {
			return err
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		if head.Draft.TextProjectionVersion < ChannelACLProjectionVersion {
			return ErrPolicyAttestationUnavailable
		}
		result := ChannelACLPersonalDisclosure{ChannelID: channelID, ProfileID: profileID, Revision: head.Draft.Revision,
			PolicyHead: head.Digest, Rules: rules}
		if head.Draft.TextProjectionVersion >= ProfileRankProjectionVersion {
			rankBasis, err := channelACLRankBasis(state, head, actor.ProfileID, profileID, &cache.current)
			if err != nil {
				return err
			}
			result.RankBasis = &rankBasis
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(result)
	})
}

func channelACLRankBasis(state State, head PolicyProof, actor, target string,
	cache *textChannelPolicyTreeCache) (ChannelACLRankBasis, error) {
	tree, err := cache.treeFor(state, head)
	if err != nil {
		return ChannelACLRankBasis{}, err
	}
	if tree.ranks == nil {
		return ChannelACLRankBasis{}, ErrPolicyConflict
	}
	inclusion, err := tree.proof(profileRankProjectionID)
	if err != nil {
		return ChannelACLRankBasis{}, err
	}
	actorProof, err := tree.ranks.proof(actor)
	if err != nil {
		return ChannelACLRankBasis{}, err
	}
	targetProof, err := tree.ranks.proof(target)
	if err != nil {
		return ChannelACLRankBasis{}, err
	}
	basis := ChannelACLRankBasis{Root: tree.ranks.digest, Inclusion: inclusion, Actor: actorProof, Target: targetProof}
	if head.Draft.TextProjectionVersion >= TextNewcomerAdmissionProjectionVersion {
		basis.Invites, err = tree.inviteAdmission.digest()
		basis.Catalogue, basis.Rosters = tree.inviteAdmission.Catalogue, tree.inviteAdmission.Rosters
	}
	return basis, err
}
