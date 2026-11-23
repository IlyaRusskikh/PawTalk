package access

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"math"
	"slices"
	"strconv"
)

const TextOrderAuthorityVersion = 7
const ChannelSettingsProjectionVersion = 9
const ChannelACLProjectionVersion = 10

type ChannelOrderAuthorityProof struct {
	ChannelID       string                 `json:"channelId"`
	Revision        int64                  `json:"revision"`
	PolicyDigest    string                 `json:"policyDigest"`
	Kind            string                 `json:"kind"`
	CategoryID      string                 `json:"categoryId"`
	Actor           Principal              `json:"actor"`
	SigningKey      string                 `json:"signingKey"`
	Salt            string                 `json:"salt"`
	Editors         EpochPackageProof      `json:"editors"`
	SettingsDigest  string                 `json:"settingsDigest,omitempty"`
	ACLRoot         string                 `json:"aclRoot,omitempty"`
	TextDigest      string                 `json:"textDigest"`
	RoleRulesDigest string                 `json:"roleRulesDigest,omitempty"`
	Inclusion       ChannelPolicyInclusion `json:"inclusion"`
}

type ChannelSettingsDisclosure struct {
	ChannelID       string                 `json:"channelId"`
	Revision        int64                  `json:"revision"`
	PolicyDigest    string                 `json:"policyDigest"`
	Kind            string                 `json:"kind"`
	CategoryID      string                 `json:"categoryId"`
	Settings        *ChannelSettings       `json:"settings"`
	EditorsRoot     string                 `json:"editorsRoot"`
	ACLRoot         string                 `json:"aclRoot,omitempty"`
	TextDigest      string                 `json:"textDigest"`
	RoleRulesDigest string                 `json:"roleRulesDigest,omitempty"`
	Inclusion       ChannelPolicyInclusion `json:"inclusion"`
}

type channelOrderCommitment struct {
	digest         string
	editorsRoot    string
	settingsDigest string
	aclRoot        string
}

func channelSettingsDigest(settings *ChannelSettings) (string, error) {
	fields := []string{"pawtalk-channel-settings-v1"}
	if settings != nil {
		fields = append(fields, settings.Name, settings.Description, strconv.FormatUint(uint64(settings.SlowmodeSeconds), 10),
			strconv.FormatUint(uint64(settings.VoiceCapacity), 10))
	}
	// Settings descriptions may exceed the wire signature frame limit.
	// Hash the same length-prefixed bytes without constructing that frame.
	digest := sha256.New()
	var length [4]byte
	for _, field := range fields {
		if uint64(len(field)) > math.MaxUint32 {
			return "", InvalidPolicy
		}
		binary.BigEndian.PutUint32(length[:], uint32(len(field)))
		digest.Write(length[:])
		digest.Write([]byte(field))
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

type channelPolicyEditor struct {
	actor              Principal
	key                string
	salt, rank, digest [32]byte
}

type channelEditorTreeKind struct {
	permission string
	domain     string
	saltMode   byte
	rankMode   byte
}

var channelOrderEditors = channelEditorTreeKind{"channel.edit", "pawtalk-channel-order-editor-v1", 5, 6}

type channelEditorWitness struct {
	editor channelPolicyEditor
	proof  EpochPackageProof
}

func channelPolicyCombinedDigest(textDigest, orderDigest string) string {
	return hexHash([]byte("pawtalk-channel-policy-with-order-v1:" + textDigest + orderDigest))
}

func (s State) channelEditorTree(channelID string, scope Scope, seed [32]byte, selected string,
	kind channelEditorTreeKind) (string, *channelEditorWitness, error) {
	editors := make([]channelPolicyEditor, 0)
	for id, device := range s.PolicyDevices {
		if device.Revoked || s.CheckGrant(s.Members[device.ProfileID], scope, kind.permission, 0) != Allowed {
			continue
		}
		if len(editors) == 8192 || !isDigest(device.ProfileID) || !signingKeyMatches(id, device.PublicKey) {
			return "", nil, InvalidPolicy
		}
		editor := channelPolicyEditor{actor: Principal{ProfileID: device.ProfileID, DeviceID: id}, key: device.PublicKey,
			salt: textRecipientBlind(seed, kind.saltMode, channelID, id), rank: textRecipientBlind(seed, kind.rankMode, channelID, id)}
		frame, err := SignatureFrame(kind.domain, id, device.ProfileID, device.PublicKey, hex.EncodeToString(editor.salt[:]))
		if err != nil {
			return "", nil, err
		}
		editor.digest = sha256.Sum256(frame)
		editors = append(editors, editor)
	}
	slices.SortFunc(editors, func(a, b channelPolicyEditor) int {
		if order := bytes.Compare(a.rank[:], b.rank[:]); order != 0 {
			return order
		}
		return bytes.Compare(a.digest[:], b.digest[:])
	})
	leaves := make([][32]byte, len(editors))
	index := -1
	for i, editor := range editors {
		leaves[i] = editor.digest
		if editor.actor.DeviceID == selected {
			index = i
		}
	}
	root, siblings := foldCommitmentLeaves(leaves, index)
	if selected == "" {
		return root, nil, nil
	}
	if index < 0 {
		return "", nil, ChannelRestricted
	}
	return root, &channelEditorWitness{editor: editors[index],
		proof: EpochPackageProof{Index: index, Count: len(editors), Siblings: siblings}}, nil
}

func (s State) channelOrderAuthority(channelID string, seed [32]byte, selected string, version int) (channelOrderCommitment, *ChannelOrderAuthorityProof, error) {
	var authority channelOrderCommitment
	channel, exists := s.Channels[channelID]
	if !exists {
		return authority, nil, ChannelRestricted
	}
	scope := s.scope(channel)
	root, witness, err := s.channelEditorTree(channelID, scope, seed, selected, channelOrderEditors)
	if err != nil {
		return authority, nil, err
	}
	authority.editorsRoot = root
	fields := []string{"pawtalk-channel-order-resource-v1", channel.Kind, channel.CategoryID, root}
	if version >= ChannelSettingsProjectionVersion {
		authority.settingsDigest, err = channelSettingsDigest(channel.Settings)
		if err != nil {
			return authority, nil, err
		}
		fields[0] = "pawtalk-channel-order-resource-v2"
		fields = append(fields, authority.settingsDigest)
	}
	if version >= ChannelACLProjectionVersion {
		acl, _, err := s.channelACLAuthority(channelID, scope, seed, "")
		if err != nil {
			return authority, nil, err
		}
		authority.aclRoot = acl.root
		fields[0] = "pawtalk-channel-order-resource-v3"
		fields = append(fields, authority.aclRoot)
	}
	frame, err := SignatureFrame(fields...)
	if err != nil {
		return authority, nil, err
	}
	authority.digest = hexHash(frame)
	if witness == nil {
		return authority, nil, nil
	}
	editor := witness.editor
	return authority, &ChannelOrderAuthorityProof{ChannelID: channelID, Kind: channel.Kind, CategoryID: channel.CategoryID,
		Actor: editor.actor, SigningKey: editor.key, Salt: hex.EncodeToString(editor.salt[:]),
		Editors: witness.proof, SettingsDigest: authority.settingsDigest, ACLRoot: authority.aclRoot}, nil
}

func orderAuthorityDisclosure(state State, head PolicyProof, channel, device string,
	cache *textChannelPolicyTreeCache) (*ChannelOrderAuthorityProof, error) {
	if head.Draft.TextProjectionVersion < TextOrderAuthorityVersion {
		return nil, ErrPolicyAttestationUnavailable
	}
	inclusion, roleRulesDigest, err := cache.inclusionWithRoleRules(state, head, channel)
	if err != nil {
		return nil, err
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	_, proof, err := state.channelOrderAuthority(channel, seed, device, head.Draft.TextProjectionVersion)
	if err != nil {
		return nil, err
	}
	proof.TextDigest, err = state.channelScopeRecipientDigest(channel, proof.Kind, seed, head.Draft.TextProjectionVersion)
	if err != nil {
		return nil, err
	}
	proof.Revision, proof.PolicyDigest, proof.Inclusion = head.Draft.Revision, head.Draft.ResultDigest, inclusion
	proof.RoleRulesDigest = roleRulesDigest
	return proof, nil
}

func (s *Store) DispatchChannelOrderAuthority(ctx context.Context, resolve ResolveSession, channel string,
	cache *TextChannelPolicyProofCache, deliver func(ChannelOrderAuthorityProof) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		resource, exists := state.Channels[channel]
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !exists ||
			state.CheckGrant(state.Members[actor.ProfileID], state.scope(resource), "channel.edit", 0) != Allowed {
			return ChannelRestricted
		}
		head, err := readPolicyHead(ctx, conn)
		if err != nil {
			return err
		}
		proof, err := orderAuthorityDisclosure(state, head, channel, actor.DeviceID, &cache.current)
		if err != nil {
			return err
		}
		return deliver(*proof)
	})
}

func (s *Store) DispatchChannelSettings(ctx context.Context, resolve ResolveSession, channel string,
	cache *TextChannelPolicyProofCache, deliver func(ChannelSettingsDisclosure) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.CanDeliver(actor.ProfileID, channel, 0) {
			return ChannelRestricted
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		proof, err := channelSettingsDisclosure(state, head, channel, &cache.current)
		if err != nil {
			return err
		}
		return deliver(proof)
	})
}

func channelSettingsDisclosure(state State, head PolicyProof, channel string, cache *textChannelPolicyTreeCache) (ChannelSettingsDisclosure, error) {
	version := head.Draft.TextProjectionVersion
	if version < ChannelSettingsProjectionVersion {
		return ChannelSettingsDisclosure{}, ErrPolicyAttestationUnavailable
	}
	inclusion, roleRulesDigest, err := cache.inclusionWithRoleRules(state, head, channel)
	if err != nil {
		return ChannelSettingsDisclosure{}, err
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed)); err != nil {
		return ChannelSettingsDisclosure{}, ErrPolicyConflict
	}
	authority, _, err := state.channelOrderAuthority(channel, seed, "", version)
	if err != nil {
		return ChannelSettingsDisclosure{}, err
	}
	resource := state.Channels[channel]
	root, err := state.channelScopeRecipientDigest(channel, resource.Kind, seed, version)
	if err != nil {
		return ChannelSettingsDisclosure{}, err
	}
	return ChannelSettingsDisclosure{ChannelID: channel, Revision: head.Draft.Revision, PolicyDigest: head.Draft.ResultDigest,
		Kind: resource.Kind, CategoryID: resource.CategoryID, Settings: resource.Settings, EditorsRoot: authority.editorsRoot,
		ACLRoot: authority.aclRoot, TextDigest: root, Inclusion: inclusion, RoleRulesDigest: roleRulesDigest}, nil
}
