package access

import (
	"context"
	"database/sql"
	"encoding/hex"
	"strconv"
)

const channelACLPermission = "channel.access.edit"

var channelACLEditors = channelEditorTreeKind{channelACLPermission, "pawtalk-channel-acl-editor-v1", 11, 12}

type ChannelACLDisclosure struct {
	ChannelID        string                 `json:"channelId"`
	Revision         int64                  `json:"revision"`
	PolicyDigest     string                 `json:"policyDigest"`
	Kind             string                 `json:"kind"`
	CategoryID       string                 `json:"categoryId"`
	Synchronized     bool                   `json:"synchronized"`
	Rules            map[string]Overwrite   `json:"rules"`
	RulesSalt        string                 `json:"rulesSalt"`
	SigningKey       string                 `json:"signingKey"`
	Actor            Principal              `json:"actor"`
	Salt             string                 `json:"salt"`
	Editors          EpochPackageProof      `json:"editors"`
	SettingsDigest   string                 `json:"settingsDigest"`
	OrderEditorsRoot string                 `json:"orderEditorsRoot"`
	TextDigest       string                 `json:"textDigest"`
	RoleRulesDigest  string                 `json:"roleRulesDigest,omitempty"`
	Inclusion        ChannelPolicyInclusion `json:"inclusion"`
}

type channelACLCommitment struct {
	root        string
	rules       map[string]Overwrite
	rulesSalt   string
	rulesDigest string
}

func (s State) channelACLAuthority(channelID string, scope Scope, seed [32]byte, device string) (channelACLCommitment, *channelEditorWitness, error) {
	result := channelACLCommitment{rules: scopedACLRoleRules(scope)}
	digest, err := channelACLRoleRulesDigest(result.rules)
	if err != nil {
		return channelACLCommitment{}, nil, err
	}
	salt := textRecipientBlind(seed, 10, channelID, "")
	result.rulesSalt = hex.EncodeToString(salt[:])
	rulesFrame, err := SignatureFrame("pawtalk-channel-acl-role-rules-v1", strconv.FormatBool(scope.Synchronized), digest, result.rulesSalt)
	if err != nil {
		return channelACLCommitment{}, nil, err
	}
	editorsRoot, witness, err := s.channelEditorTree(channelID, scope, seed, device, channelACLEditors)
	if err != nil {
		return channelACLCommitment{}, nil, err
	}
	result.rulesDigest = hexHash(rulesFrame)
	frame, err := SignatureFrame("pawtalk-channel-acl-authority-v1", result.rulesDigest, editorsRoot)
	if err != nil {
		return channelACLCommitment{}, nil, err
	}
	result.root = hexHash(frame)
	return result, witness, nil
}

func (s *Store) DispatchChannelACL(ctx context.Context, resolve ResolveSession, channel string,
	cache *TextChannelPolicyProofCache, deliver func(ChannelACLDisclosure) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if _, err := state.checkScopedChannelACLAccess(actor, channel); err != nil {
			return err
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		proof, _, err := channelACLDisclosure(state, head, channel, actor.DeviceID, &cache.current)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(proof)
	})
}

func channelACLDisclosure(state State, head PolicyProof, channel, device string,
	cache *textChannelPolicyTreeCache) (ChannelACLDisclosure, string, error) {
	version := head.Draft.TextProjectionVersion
	if version < ChannelACLProjectionVersion {
		return ChannelACLDisclosure{}, "", ErrPolicyAttestationUnavailable
	}
	inclusion, roleRulesDigest, err := cache.inclusionWithRoleRules(state, head, channel)
	if err != nil {
		return ChannelACLDisclosure{}, "", err
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed)); err != nil {
		return ChannelACLDisclosure{}, "", ErrPolicyConflict
	}
	resource := state.Channels[channel]
	scope := state.scope(resource)
	acl, witness, err := state.channelACLAuthority(channel, scope, seed, device)
	if err != nil {
		return ChannelACLDisclosure{}, "", err
	}
	orderRoot, _, err := state.channelEditorTree(channel, scope, seed, "", channelOrderEditors)
	if err != nil {
		return ChannelACLDisclosure{}, "", err
	}
	settingsDigest, err := channelSettingsDigest(resource.Settings)
	if err != nil {
		return ChannelACLDisclosure{}, "", err
	}
	textDigest, err := state.channelScopeRecipientDigest(channel, resource.Kind, seed, version)
	if err != nil {
		return ChannelACLDisclosure{}, "", err
	}
	return ChannelACLDisclosure{ChannelID: channel, Revision: head.Draft.Revision, PolicyDigest: head.Draft.ResultDigest,
		Kind: resource.Kind, CategoryID: resource.CategoryID, Synchronized: resource.Synchronized,
		Rules: acl.rules, RulesSalt: acl.rulesSalt, Actor: witness.editor.actor, SigningKey: witness.editor.key,
		Salt: hex.EncodeToString(witness.editor.salt[:]), Editors: witness.proof, SettingsDigest: settingsDigest,
		OrderEditorsRoot: orderRoot, TextDigest: textDigest, Inclusion: inclusion, RoleRulesDigest: roleRulesDigest}, acl.rulesDigest, nil
}
