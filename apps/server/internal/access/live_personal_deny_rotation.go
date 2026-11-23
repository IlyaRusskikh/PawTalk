package access

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"maps"
	"strconv"
)

// PersonalDenyRotationEvidence proves the audience after a personal deny.
// An unchanged archive audience has no removed group.
type PersonalDenyRotationEvidence struct {
	PreviousRevision   int64                             `json:"previousRevision"`
	PreviousHead       string                            `json:"previousHead"`
	SuccessorHead      string                            `json:"successorHead"`
	OperationID        string                            `json:"operationId"`
	Actor              Principal                         `json:"actor"`
	TargetProfileID    string                            `json:"targetProfileId"`
	EditorProof        string                            `json:"editorProof"`
	Authority          LivePersonalDenyACLAuthority      `json:"authority"`
	RankBasis          ChannelACLRankBasis               `json:"rankBasis"`
	PreviousTextPolicy *TextChannelPolicyDisclosure      `json:"previousTextPolicy"`
	SurvivorOpenings   map[string]RotationProfileOpening `json:"survivorOpenings"`
	RemovedGroup       *LivePersonalDenyRemovedGroup     `json:"removedGroup,omitempty"`
}

type LivePersonalDenyACLAuthority struct {
	ChannelID        string                 `json:"channelId"`
	Revision         int64                  `json:"revision"`
	PolicyDigest     string                 `json:"policyDigest"`
	Kind             string                 `json:"kind"`
	CategoryID       string                 `json:"categoryId"`
	RulesDigest      string                 `json:"rulesDigest"`
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

type LivePersonalDenyRemovedGroup struct {
	Salt   string `json:"salt"`
	Digest string `json:"digest"`
}

func livePersonalDenyTransitionDigest(record EpochRecord, evidence PersonalDenyRotationEvidence) (string, error) {
	if record.Purpose != LiveEpoch {
		return "", InvalidAction
	}
	return personalDenyTransitionDigest(record, evidence)
}

func personalDenyTransitionDigest(record EpochRecord, evidence PersonalDenyRotationEvidence) (string, error) {
	if record.Purpose != LiveEpoch && record.Purpose != ArchiveEpoch {
		return "", InvalidAction
	}
	frame, err := SignatureFrame("pawtalk-protected-"+record.Purpose+"-personal-deny-v1",
		record.ChannelID, strconv.FormatInt(evidence.PreviousRevision, 10), evidence.PreviousHead,
		strconv.FormatInt(record.Revision, 10), evidence.SuccessorHead, record.PolicyDigest, evidence.OperationID,
		evidence.Actor.ProfileID, evidence.Actor.DeviceID, evidence.TargetProfileID, evidence.EditorProof)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func checkEpochTransition(ctx context.Context, query SessionQuery, state State, actor Principal, record EpochRecord,
	recipients map[string]KeyRecipient, verify VerifyEpochRecord, inviteBatchBase *int64) error {
	head, err := readPolicyHead(ctx, query)
	if err != nil {
		return err
	}
	if head.Draft.Revision != record.Revision || head.Draft.ResultDigest != record.PolicyDigest {
		return ErrPolicyConflict
	}
	var history textChannelPolicyTreeCache
	expected := record.LiveTransitionDigest
	if record.Purpose == ArchiveEpoch {
		expected = record.ArchiveTransitionDigest
	}
	if head.Draft.Action == EditScopedRoles {
		evidence, err := scopedRoleAssignmentRotationEvidence(ctx, query, state, head, RotationTask{EpochRecord: record, Recipients: recipients}, actor, &history)
		if err != nil {
			return err
		}
		if evidence == nil {
			return ErrEpochConflict
		}
		digest, err := scopedRoleAssignmentEpochDigest(record, evidence.Record)
		if err != nil {
			return err
		}
		if digest != expected {
			return ErrEpochConflict
		}
		return nil
	}
	if head.Draft.Action == RedeemPolicyInvite {
		task := RotationTask{EpochRecord: record, Recipients: recipients}
		evidence, err := inviteAdmissionRotationEvidence(ctx, query, state, head, task, actor, &history, verify)
		if err != nil {
			return err
		}
		if evidence != nil {
			digest, err := inviteAdmissionTransitionDigest(record, *evidence)
			if err != nil {
				return err
			}
			if digest != expected {
				return ErrEpochConflict
			}
			return nil
		}
		batch, err := readCurrentInviteAdmissionBatch(ctx, query, state, head, task, actor, &history, verify)
		if err != nil {
			return err
		}
		if batch == nil {
			return ErrEpochConflict
		}
		digest, err := inviteAdmissionBatchDigest(record, *batch)
		if err != nil {
			return err
		}
		if digest != expected {
			return ErrEpochConflict
		}
		*inviteBatchBase = batch.PreviousRevision
		return nil
	}
	if head.Draft.Action == EditScopedChannelACLRoleRules {
		evidence, err := roleViewDenyRotationEvidence(ctx, query, state, head, RotationTask{EpochRecord: record, Recipients: recipients}, actor, &history)
		if err != nil {
			return err
		}
		if evidence == nil {
			return ErrEpochConflict
		}
		digest, err := roleViewDenyTransitionDigest(record, evidence.RoleViewDenyEvidence)
		if err != nil {
			return err
		}
		if digest != expected {
			return ErrEpochConflict
		}
		return nil
	}
	evidence, err := personalDenyRotationEvidence(ctx, query, state, head,
		RotationTask{EpochRecord: record, Recipients: recipients}, actor, &history)
	if err != nil {
		return err
	}
	if evidence == nil {
		return ErrEpochConflict
	}
	digest, err := personalDenyTransitionDigest(record, *evidence)
	if err != nil {
		return err
	}
	if expected != digest {
		return ErrEpochConflict
	}
	return nil
}

func livePersonalDenyEvidence(ctx context.Context, query SessionQuery, current State, head PolicyProof, task RotationTask,
	claimant Principal, historical *textChannelPolicyTreeCache) (*PersonalDenyRotationEvidence, error) {
	if task.Purpose != LiveEpoch {
		return nil, nil
	}
	return personalDenyRotationEvidence(ctx, query, current, head, task, claimant, historical)
}

func personalDenyRotationEvidence(ctx context.Context, query SessionQuery, current State, head PolicyProof, task RotationTask,
	claimant Principal, historical *textChannelPolicyTreeCache) (*PersonalDenyRotationEvidence, error) {
	channel, purpose := task.ChannelID, task.Purpose
	minVersion := TextGroupedRotationProjectionVersion
	switch purpose {
	case ArchiveEpoch:
		minVersion = TextGroupedArchiveRotationProjectionVersion
	case LiveEpoch:
	default:
		return nil, nil
	}
	change := head.Draft.ResourceChange
	if head.Draft.Action != EditScopedChannelACLPersonal || change == nil || change.ID != channel ||
		change.ACLPersonalEdit == nil || change.ACLPersonalEdit.Permission != ChannelView || change.ACLPersonalEdit.Rule != "deny" ||
		head.Draft.TextProjectionVersion < minVersion || !current.hasPolicyDevice(claimant) ||
		!current.canLoadEpoch(claimant, channel, purpose) {
		return nil, nil
	}
	previous, predecessor, err := readPrecedingPolicyState(ctx, query, head.Draft)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	target := previous.Members[change.TargetProfileID]
	first := previous.Admissions[channel][claimant.ProfileID].FirstPosition
	if predecessor.Draft.TextProjectionVersion != head.Draft.TextProjectionVersion ||
		previous.PolicyDevices[claimant.DeviceID] != current.PolicyDevices[claimant.DeviceID] ||
		!previous.canLoadEpoch(claimant, channel, purpose) ||
		first == 0 || first != current.Admissions[channel][claimant.ProfileID].FirstPosition ||
		!previous.CanDeliver(target.ID, channel, 0) || current.CanDeliver(target.ID, channel, 0) ||
		previous.owner(target) || previous.baseGrant(target, Administrator) {
		return nil, nil
	}
	if _, _, err := previous.checkScopedChannelACLPersonal(head.Principal, head.Draft, predecessor); err != nil {
		return nil, nil
	}
	var attested bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM protected_policy_attestations WHERE revision=?
		UNION ALL SELECT 1 FROM protected_policy_attestations_v2 WHERE revision=?
	)`, predecessor.Draft.Revision, predecessor.Draft.Revision).Scan(&attested); err != nil {
		return nil, err
	}
	if !attested {
		return nil, nil
	}

	survivors, err := previous.rotationRecipients(channel, purpose)
	if err != nil {
		return nil, nil
	}
	removed := make(map[string]KeyRecipient)
	for id, recipient := range survivors {
		if recipient.ProfileID == target.ID {
			removed[id] = recipient
			delete(survivors, id)
		}
	}
	if !maps.Equal(survivors, task.Recipients) || purpose == LiveEpoch && len(removed) == 0 {
		return nil, nil
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(predecessor.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	var removedGroup *LivePersonalDenyRemovedGroup
	if len(removed) != 0 {
		// The removed group's inner salt and roster stay private.
		targetOpening := textRotationProfileOpening(seed, channel, purpose, target.ID)
		removedDigest, err := textRotationDigest(removed, targetOpening.ContentSalt)
		if err != nil {
			return nil, err
		}
		removedGroup = &LivePersonalDenyRemovedGroup{Salt: targetOpening.Salt, Digest: removedDigest}
	}
	authority, rulesDigest, err := channelACLDisclosure(previous, predecessor, channel, head.Principal.DeviceID, historical)
	if err != nil {
		return nil, err
	}
	rankBasis, err := channelACLRankBasis(previous, predecessor, head.Principal.ProfileID, target.ID, historical)
	if err != nil {
		return nil, err
	}
	text, err := textChannelDisclosure(previous, predecessor, channel, claimant.DeviceID, historical, 0)
	if err != nil {
		return nil, err
	}
	return &PersonalDenyRotationEvidence{
		PreviousRevision: predecessor.Draft.Revision, PreviousHead: predecessor.Digest, SuccessorHead: head.Digest,
		OperationID: head.Draft.OperationID, Actor: head.Principal, TargetProfileID: target.ID, EditorProof: change.ACLPersonalEdit.EditorProof,
		Authority: LivePersonalDenyACLAuthority{ChannelID: authority.ChannelID, Revision: authority.Revision, PolicyDigest: authority.PolicyDigest,
			Kind: authority.Kind, CategoryID: authority.CategoryID, RulesDigest: rulesDigest, SigningKey: authority.SigningKey,
			Actor: authority.Actor, Salt: authority.Salt, Editors: authority.Editors, SettingsDigest: authority.SettingsDigest,
			OrderEditorsRoot: authority.OrderEditorsRoot, TextDigest: authority.TextDigest, Inclusion: authority.Inclusion,
			RoleRulesDigest: authority.RoleRulesDigest},
		RankBasis: rankBasis, PreviousTextPolicy: text, SurvivorOpenings: rotationProfileOpenings(survivors, seed, channel, purpose),
		RemovedGroup: removedGroup,
	}, nil
}
