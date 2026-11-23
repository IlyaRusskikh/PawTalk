package access

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"reflect"
	"strconv"
)

const EditScopedChannelACLRoleRules = "channel.acl.roles.scoped"

var ErrChannelACLRoleEditProof = errors.New("invalid protected channel ACL role editor proof")

type PolicyChannelACLRoleEdit struct {
	CutoverDigest       string
	PreviousRulesDigest string
	EditorProof         string
	ServerKey           string
}

func scopedACLRoleRules(scope Scope) map[string]Overwrite {
	if acl := scope.effectiveACL(); acl != nil {
		return channelRules(ACL{Roles: acl.Roles}, scope.Kind).Roles
	}
	return make(map[string]Overwrite)
}

func channelACLRoleRulesDigest(rules map[string]Overwrite) (string, error) {
	raw, err := json.Marshal(rules)
	if err != nil {
		return "", err
	}
	return hexHash(raw), nil
}

func (s State) checkScopedChannelACLAccess(actor Principal, channelID string) (Channel, error) {
	channel, exists := s.Channels[channelID]
	if !s.PolicyAnchored || !s.hasPolicyDevice(actor) || !exists ||
		s.CheckGrant(s.Members[actor.ProfileID], s.scope(channel), channelACLPermission, 0) != Allowed {
		return Channel{}, ChannelRestricted
	}
	return channel, nil
}

func (s State) checkScopedChannelACLRoleRules(actor Principal, draft PolicyDraft, head PolicyProof) (Channel, error) {
	change := draft.ResourceChange
	if draft.Action != EditScopedChannelACLRoleRules || change == nil || change.ACL == nil || change.ACLRoleEdit == nil ||
		*change != (PolicyResourceChange{ID: change.ID, ACL: change.ACL, ACLRoleEdit: change.ACLRoleEdit}) ||
		change.ACL.Roles == nil || change.ACL.Profiles != nil || !validRotationID(change.ID) ||
		!isDigest(change.ACLRoleEdit.CutoverDigest) || !isDigest(change.ACLRoleEdit.PreviousRulesDigest) ||
		!validRecoveryProof(change.ACLRoleEdit.EditorProof, ed25519.SignatureSize) ||
		!validRecoveryProof(change.ACLRoleEdit.ServerKey, ed25519.PublicKeySize) {
		return Channel{}, InvalidAction
	}
	if head.Draft.TextProjectionVersion < ChannelACLProjectionVersion {
		return Channel{}, ErrPolicyAttestationUnavailable
	}
	channel, err := s.checkScopedChannelACLAccess(actor, change.ID)
	if err != nil {
		return Channel{}, err
	}
	for _, rule := range change.ACL.Roles {
		if len(rule.Allow)+len(rule.Deny) == 0 || len(grantSet(rule.Allow)) != len(rule.Allow) ||
			len(grantSet(rule.Deny)) != len(rule.Deny) {
			return Channel{}, InvalidPolicy
		}
	}
	if !s.validACL(*change.ACL, channel.Kind) {
		return Channel{}, InvalidPolicy
	}
	previous := scopedACLRoleRules(s.scope(channel))
	digest, err := channelACLRoleRulesDigest(previous)
	if err != nil {
		return Channel{}, err
	}
	if digest != change.ACLRoleEdit.PreviousRulesDigest {
		return Channel{}, ErrPolicyConflict
	}
	if maps.EqualFunc(previous, change.ACL.Roles, func(before, after Overwrite) bool {
		return maps.Equal(grantSet(before.Allow), grantSet(after.Allow)) && maps.Equal(grantSet(before.Deny), grantSet(after.Deny))
	}) {
		return Channel{}, InvalidAction
	}
	return channel, nil
}

func (s *State) applyScopedChannelACLRoleRules(actor Principal, draft PolicyDraft, head PolicyProof) error {
	channel, err := s.checkScopedChannelACLRoleRules(actor, draft, head)
	if err != nil {
		return err
	}
	scope := s.scope(channel)
	var profiles map[string]Overwrite
	if acl := scope.effectiveACL(); acl != nil {
		profiles = channelRules(ACL{Profiles: acl.Profiles}, channel.Kind).Profiles
	}
	change := draft.ResourceChange
	return s.setChannelACL(actor.ProfileID, change.ID, ACL{Roles: change.ACL.Roles, Profiles: profiles})
}

func VerifyScopedChannelACLRoleRulesEdit(ctx context.Context, query SessionQuery, serverID string, actor Principal, draft PolicyDraft) error {
	state, head, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return err
	}
	channel, err := state.checkScopedChannelACLRoleRules(actor, draft, head)
	if err != nil {
		return err
	}
	change := draft.ResourceChange
	next, err := channelACLRoleRulesDigest(change.ACL.Roles)
	if err != nil {
		return err
	}
	frame, err := SignatureFrame("pawtalk-protected-channel-acl-roles-edit-v1", serverID, change.ACLRoleEdit.CutoverDigest,
		actor.ProfileID, actor.DeviceID, draft.OperationID, strconv.FormatInt(head.Draft.Revision, 10), head.Digest,
		change.ID, channel.Kind, channel.CategoryID, change.ACLRoleEdit.PreviousRulesDigest, next)
	if err != nil {
		return err
	}
	signingKey := state.PolicyDevices[actor.DeviceID].PublicKey
	if !signingKeyMatches(actor.DeviceID, signingKey) ||
		!verifyScopeAuthoritySignature(parseScopeAuthorityKey(signingKey), frame, change.ACLRoleEdit.EditorProof) {
		return ErrChannelACLRoleEditProof
	}
	return nil
}

func (s *Store) CommitScopedChannelACLRoleRulesEdit(ctx context.Context, resolve ResolveSession, intent PolicyDraft,
	sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	if intent.Action != EditScopedChannelACLRoleRules {
		return PolicyProof{}, InvalidAction
	}
	return s.commitScopedChannelACLIntent(ctx, resolve, intent, sign, verify)
}

func (s *Store) commitScopedChannelACLIntent(ctx context.Context, resolve ResolveSession, intent PolicyDraft,
	sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	if intent.ResourceChange == nil ||
		!validRecoveryIntentFields(intent) || resolve == nil || sign == nil || verify == nil {
		return PolicyProof{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	state, head, err := readCommittedPolicyState(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	change := intent.ResourceChange
	if intent.Action == EditScopedChannelACLPersonal {
		if _, _, err := state.checkScopedChannelACLTarget(actor, change.ID, change.TargetProfileID); err != nil {
			return PolicyProof{}, err
		}
	} else {
		if _, err := state.checkScopedChannelACLAccess(actor, change.ID); err != nil {
			return PolicyProof{}, err
		}
	}
	if head.Draft.TextProjectionVersion < ChannelACLProjectionVersion {
		return PolicyProof{}, ErrPolicyAttestationUnavailable
	}
	prior, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE operation_id=?`, intent.OperationID))
	if err == nil {
		if prior.Principal != actor || prior.Draft.Action != intent.Action ||
			prior.Draft.PreviousDigest != intent.PreviousDigest || !reflect.DeepEqual(prior.Draft.ResourceChange, intent.ResourceChange) {
			return PolicyProof{}, ErrPolicyConflict
		}
		return prior, verify(ctx, tx, actor, prior.Draft)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, err
	}
	if head.Digest != intent.PreviousDigest {
		return PolicyProof{}, ErrPolicyConflict
	}
	var seed [32]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return PolicyProof{}, err
	}
	intent.TextProjectionSeed = hex.EncodeToString(seed[:])
	intent.TextProjectionVersion = head.Draft.TextProjectionVersion
	draft, err := preparePolicyDraft(&state, head.Draft.Revision, head, actor, intent)
	if err != nil {
		return PolicyProof{}, err
	}
	draft.Signature, err = sign(ctx, tx, actor, draft)
	if err != nil {
		return PolicyProof{}, err
	}
	proof, err := s.commitPolicyInTransaction(ctx, tx, actor, verify, draft, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	return proof, tx.Commit()
}
