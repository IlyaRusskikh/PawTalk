package access

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"maps"
	"strconv"
)

// RoleViewDenyEvidence identifies the exact role rule change and proves the
// preceding scoped authority without opening role rules or removed keys.
type RoleViewDenyEvidence struct {
	PreviousRevision   int64                        `json:"previousRevision"`
	PreviousHead       string                       `json:"previousHead"`
	SuccessorHead      string                       `json:"successorHead"`
	OperationID        string                       `json:"operationId"`
	Actor              Principal                    `json:"actor"`
	EditorProof        string                       `json:"editorProof"`
	Authority          LivePersonalDenyACLAuthority `json:"authority"`
	PreviousTextPolicy *TextChannelPolicyDisclosure `json:"previousTextPolicy"`
	Effect             RoleViewDenyEffectProof      `json:"effect"`
}

type RoleViewDenyRotationEvidence struct {
	RoleViewDenyEvidence
	SurvivorOpenings map[string]RotationProfileOpening       `json:"survivorOpenings"`
	RemovedGroups    map[string]LivePersonalDenyRemovedGroup `json:"removedGroups"`
}

type roleViewDenyBasis struct {
	previous    State
	predecessor PolicyProof
	rotation    RoleViewDenyRotationEvidence
}

func liveRoleViewDenyTransitionDigest(record EpochRecord, evidence RoleViewDenyEvidence) (string, error) {
	if record.Purpose != LiveEpoch {
		return "", InvalidAction
	}
	return roleViewDenyTransitionDigest(record, evidence)
}

func roleViewDenyTransitionDigest(record EpochRecord, evidence RoleViewDenyEvidence) (string, error) {
	if record.Purpose != LiveEpoch && record.Purpose != ArchiveEpoch {
		return "", InvalidAction
	}
	frame, err := SignatureFrame("pawtalk-protected-"+record.Purpose+"-role-view-deny-v1",
		record.ChannelID, strconv.FormatInt(evidence.PreviousRevision, 10), evidence.PreviousHead,
		strconv.FormatInt(record.Revision, 10), evidence.SuccessorHead, record.PolicyDigest, evidence.OperationID,
		evidence.Actor.ProfileID, evidence.Actor.DeviceID, evidence.Effect.RoleID, evidence.Effect.PreviousRulesDigest,
		evidence.Effect.NextRulesDigest, evidence.EditorProof)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func roleViewDenyRotationEvidence(ctx context.Context, query SessionQuery, current State, head PolicyProof, task RotationTask,
	claimant Principal, historical *textChannelPolicyTreeCache) (*RoleViewDenyRotationEvidence, error) {
	basis, err := readRoleViewDenyBasis(ctx, query, current, head, task, claimant, historical)
	if err != nil || basis == nil {
		return nil, err
	}
	return &basis.rotation, nil
}

func readRoleViewDenyBasis(ctx context.Context, query SessionQuery, current State, head PolicyProof, task RotationTask,
	claimant Principal, historical *textChannelPolicyTreeCache) (*roleViewDenyBasis, error) {
	channel, purpose := task.ChannelID, task.Purpose
	change := head.Draft.ResourceChange
	if (purpose != LiveEpoch && purpose != ArchiveEpoch) || head.Draft.Action != EditScopedChannelACLRoleRules ||
		change == nil || change.ID != channel || change.ACL == nil || change.ACLRoleEdit == nil ||
		task.Revision != head.Draft.Revision || task.PolicyDigest != head.Draft.ResultDigest ||
		head.Draft.TextProjectionVersion < TextRoleViewDenyProjectionVersion {
		return nil, nil
	}
	previous, predecessor, err := readPrecedingPolicyState(ctx, query, head.Draft)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if predecessor.Draft.TextProjectionVersion != head.Draft.TextProjectionVersion ||
		!retainedPersonalDenyReader(previous, current, task.EpochRecord, claimant) {
		return nil, nil
	}
	if _, err := previous.checkScopedChannelACLRoleRules(head.Principal, head.Draft, predecessor); err != nil {
		return nil, nil
	}
	var attested bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM protected_policy_attestations WHERE revision=?
		UNION ALL SELECT 1 FROM protected_policy_attestations_v2 WHERE revision=?
	)`, predecessor.Draft.Revision, predecessor.Draft.Revision).Scan(&attested); err != nil || !attested {
		return nil, err
	}
	nextRules, err := channelACLRoleRulesDigest(change.ACL.Roles)
	if err != nil {
		return nil, err
	}
	currentRules, err := channelACLRoleRulesDigest(scopedACLRoleRules(current.scope(current.Channels[channel])))
	if err != nil || currentRules != nextRules {
		return nil, err
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(predecessor.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	effectRoot, effect, err := previous.roleViewDenyCommitment(channel, seed, nextRules)
	if err != nil || effect == nil {
		return nil, err
	}
	if effect.PreviousRulesDigest != change.ACLRoleEdit.PreviousRulesDigest || effect.NextRulesDigest != nextRules || len(effect.ExcludedProfiles) == 0 {
		return nil, nil
	}
	excluded := make(map[string]bool, len(effect.ExcludedProfiles))
	for _, profile := range effect.ExcludedProfiles {
		if excluded[profile] || !previous.CanDeliver(profile, channel, 0) || current.CanDeliver(profile, channel, 0) {
			return nil, nil
		}
		excluded[profile] = true
	}
	survivors, err := previous.rotationRecipients(channel, purpose)
	if err != nil {
		return nil, err
	}
	removed := make(map[string]map[string]KeyRecipient)
	for id, recipient := range survivors {
		if excluded[recipient.ProfileID] {
			group := removed[recipient.ProfileID]
			if group == nil {
				group = make(map[string]KeyRecipient)
				removed[recipient.ProfileID] = group
			}
			group[id] = recipient
			delete(survivors, id)
		}
	}
	if !maps.Equal(survivors, task.Recipients) {
		return nil, nil
	}
	removedGroups := make(map[string]LivePersonalDenyRemovedGroup, len(removed))
	for profile, group := range removed {
		opening := textRotationProfileOpening(seed, channel, purpose, profile)
		digest, err := textRotationDigest(group, opening.ContentSalt)
		if err != nil {
			return nil, err
		}
		removedGroups[profile] = LivePersonalDenyRemovedGroup{Salt: opening.Salt, Digest: digest}
	}
	authority, rulesDigest, err := channelACLDisclosure(previous, predecessor, channel, head.Principal.DeviceID, historical)
	if err != nil {
		return nil, err
	}
	text, err := textChannelDisclosure(previous, predecessor, channel, claimant.DeviceID, historical, 0)
	if err != nil {
		return nil, err
	}
	if text == nil || text.Rotation == nil || text.Rotation.RoleViewDenies != effectRoot {
		return nil, ErrPolicyConflict
	}
	evidence := RoleViewDenyEvidence{
		PreviousRevision: predecessor.Draft.Revision, PreviousHead: predecessor.Digest, SuccessorHead: head.Digest,
		OperationID: head.Draft.OperationID, Actor: head.Principal, EditorProof: change.ACLRoleEdit.EditorProof,
		Authority: LivePersonalDenyACLAuthority{ChannelID: authority.ChannelID, Revision: authority.Revision, PolicyDigest: authority.PolicyDigest,
			Kind: authority.Kind, CategoryID: authority.CategoryID, RulesDigest: rulesDigest, SigningKey: authority.SigningKey,
			Actor: authority.Actor, Salt: authority.Salt, Editors: authority.Editors, SettingsDigest: authority.SettingsDigest,
			OrderEditorsRoot: authority.OrderEditorsRoot, TextDigest: authority.TextDigest, Inclusion: authority.Inclusion,
			RoleRulesDigest: authority.RoleRulesDigest},
		PreviousTextPolicy: text, Effect: *effect,
	}
	return &roleViewDenyBasis{previous: previous, predecessor: predecessor, rotation: RoleViewDenyRotationEvidence{
		RoleViewDenyEvidence: evidence, SurvivorOpenings: rotationProfileOpenings(survivors, seed, channel, purpose), RemovedGroups: removedGroups,
	}}, nil
}
