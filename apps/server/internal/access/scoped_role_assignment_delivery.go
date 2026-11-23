package access

import (
	"context"
	"encoding/hex"
	"strconv"
)

type ScopedRoleAssignmentReadEvidence struct {
	Record                   PolicyProof                  `json:"record"`
	Assignment               scopedRoleAssignmentWitness  `json:"assignment"`
	PreviousSignerTextPolicy *TextChannelPolicyDisclosure `json:"previousSignerTextPolicy"`
	PreviousViewerTextPolicy *TextChannelPolicyDisclosure `json:"previousViewerTextPolicy,omitempty"`
	SuccessorViewerPolicy    *TextChannelPolicyDisclosure `json:"successorViewerPolicy,omitempty"`
}

type liveRoleHistoryEvidence struct {
	Archive    *EpochProof                      `json:"archive,omitempty"`
	Receipt    []byte                           `json:"receipt,omitempty"`
	Transition ScopedRoleAssignmentReadEvidence `json:"transition"`
}

type SignLiveRoleHistoryReceipt func(context.Context, SessionQuery, EpochRecord, PolicyProof) ([]byte, error)

// LiveRoleHistoryReceiptFrame authenticates the applied transition while the
// archive task is pending. The reader separately verifies the editor's
// authority and both live admission statements against the policy roots.
func LiveRoleHistoryReceiptFrame(serverID string, live EpochRecord, proof PolicyProof) ([]byte, error) {
	draft := proof.Draft
	if live.Purpose != LiveEpoch || draft.Action != EditScopedRoles || draft.ResourceChange == nil || draft.ResourceChange.RolesEdit == nil {
		return nil, InvalidAction
	}
	edit := draft.ResourceChange.RolesEdit
	return SignatureFrame("pawtalk-live-role-history-receipt-v1", serverID, edit.CutoverDigest, live.ChannelID,
		strconv.FormatUint(live.Generation, 10), live.KeyID, hexHash(live.Signature), draft.OperationID,
		proof.Principal.ProfileID, proof.Principal.DeviceID, strconv.FormatInt(draft.Revision, 10),
		draft.PreviousDigest, proof.Digest, draft.ResultDigest, draft.TextProjectionRoot, edit.EditorProof)
}

func readLiveRoleHistoryEvidence(ctx context.Context, query SessionQuery, state State, live EpochRecord, viewer Principal,
	verify VerifyEpochRecord, sign SignLiveRoleHistoryReceipt, history *textChannelPolicyTreeCache) (*liveRoleHistoryEvidence, error) {
	channel := live.ChannelID
	head, err := readPolicyHead(ctx, query)
	if err != nil || head.Draft.Action != EditScopedRoles || head.Draft.TextProjectionVersion != ProfileRoleAuthorityProjectionVersion ||
		head.Draft.Revision <= live.Revision {
		return nil, err
	}
	var archive *EpochProof
	if generation := state.ArchiveHeads[channel]; generation != 0 {
		var key string
		if err := query.QueryRowContext(ctx, `SELECT key_id FROM protected_epochs WHERE channel_id=? AND purpose=? AND generation=?`,
			channel, ArchiveEpoch, generation).Scan(&key); err != nil {
			return nil, err
		}
		candidate, err := readEpoch(ctx, query, channel, ArchiveEpoch, key)
		if err != nil {
			return nil, err
		}
		if candidate.Record.Revision == head.Draft.Revision && candidate.Record.PolicyDigest == head.Draft.ResultDigest &&
			candidate.Record.ArchiveTransitionDigest != "" {
			if err := verify(ctx, query, candidate.Principal, candidate.Record); err != nil {
				return nil, err
			}
			archive = &candidate
		}
	}
	if archive == nil && sign == nil {
		return nil, nil
	}
	previous, predecessor, err := readAttestedRoleAssignmentPredecessor(ctx, query, head.Draft)
	if err != nil || predecessor.Digest == "" {
		return nil, err
	}
	evidence, err := buildLiveRoleHistoryEvidence(previous, state, predecessor, head, live, archive, viewer, history)
	if err != nil || evidence == nil || archive != nil {
		return evidence, err
	}
	evidence.Receipt, err = sign(ctx, query, live, evidence.Transition.Record)
	return evidence, err
}

func buildLiveRoleHistoryEvidence(previous, current State, predecessor, head PolicyProof, live EpochRecord, archive *EpochProof,
	viewer Principal, history *textChannelPolicyTreeCache) (*liveRoleHistoryEvidence, error) {
	channel := live.ChannelID
	if live.Purpose != LiveEpoch || live.Revision > predecessor.Draft.Revision ||
		!retainedPersonalDenyReader(previous, current, live, viewer) ||
		head.Draft.ResourceChange == nil || head.Draft.ResourceChange.RolesEdit == nil {
		return nil, nil
	}
	change := head.Draft.ResourceChange.RolesEdit.Change
	if validateScopedRoleRosterCommitment(predecessor, change) != nil {
		return nil, nil
	}
	target := change.TargetProfile
	targetGrant := func(state State, permission string) bool {
		return state.CheckGrant(state.Members[target], state.scope(state.Channels[channel]), permission, 0) == Allowed
	}
	if !targetGrant(previous, ChannelView) || !targetGrant(current, ChannelView) ||
		targetGrant(previous, "history.full") == targetGrant(current, "history.full") {
		return nil, nil
	}
	var seed [32]byte
	if seedHex := predecessor.Draft.TextProjectionSeed; !isDigest(seedHex) {
		return nil, ErrPolicyConflict
	} else {
		_, _ = hex.Decode(seed[:], []byte(seedHex))
	}
	assignment, err := previous.scopedRoleAssignmentWitness(predecessor, head, channel, seed, history, false)
	if err != nil {
		return nil, err
	}
	view, err := textChannelDisclosure(previous, predecessor, channel, viewer.DeviceID, history, 0)
	if err != nil {
		return nil, err
	}
	evidence := &liveRoleHistoryEvidence{Transition: ScopedRoleAssignmentReadEvidence{
		Record: scopedRoleAssignmentRecord(head), Assignment: assignment, PreviousViewerTextPolicy: view,
	}}
	if archive != nil {
		record := archive.Record
		if record.Purpose != ArchiveEpoch || record.ChannelID != channel || record.Revision != head.Draft.Revision ||
			record.PolicyDigest != head.Draft.ResultDigest || !retainedPersonalDenyReader(previous, current, record, archive.Principal) {
			return nil, ErrEpochConflict
		}
		digest, err := scopedRoleAssignmentEpochDigest(record, head)
		if err != nil || digest != record.ArchiveTransitionDigest {
			return nil, ErrEpochConflict
		}
		evidence.Archive = &EpochProof{Principal: archive.Principal, Record: record}
		evidence.Transition.PreviousSignerTextPolicy, err = textChannelDisclosure(previous, predecessor, channel,
			archive.Principal.DeviceID, history, 0)
		if err != nil {
			return nil, err
		}
	}
	return evidence, nil
}

func scopedRoleAssignmentReadEvidence(ctx context.Context, query SessionQuery, current, successor State, head PolicyProof, epoch EpochProof,
	viewer Principal, history *textChannelPolicyTreeCache) (*ScopedRoleAssignmentReadEvidence, error) {
	if head.Draft.Action != EditScopedRoles || head.Draft.TextProjectionVersion != ProfileRoleAuthorityProjectionVersion ||
		head.Draft.Revision != epoch.Record.Revision || head.Draft.ResultDigest != epoch.Record.PolicyDigest {
		return nil, nil
	}
	previous, predecessor, err := readAttestedRoleAssignmentPredecessor(ctx, query, head.Draft)
	if err != nil || predecessor.Digest == "" {
		return nil, err
	}
	return buildScopedRoleAssignmentReadEvidence(previous, successor, current, predecessor, head, epoch, viewer, history)
}

func buildScopedRoleAssignmentReadEvidence(previous, successor, current State, predecessor, head PolicyProof, epoch EpochProof,
	viewer Principal, history *textChannelPolicyTreeCache) (*ScopedRoleAssignmentReadEvidence, error) {
	record := epoch.Record
	channel, purpose := record.ChannelID, record.Purpose
	if !retainedPersonalDenyReader(successor, current, record, viewer) {
		return nil, nil
	}
	marker := record.LiveTransitionDigest
	if purpose == ArchiveEpoch {
		marker = record.ArchiveTransitionDigest
	}
	digest, err := scopedRoleAssignmentEpochDigest(record, head)
	if err != nil {
		return nil, err
	}
	if marker != digest {
		return nil, ErrEpochConflict
	}
	recipients, err := successor.rotationRecipients(channel, purpose)
	if err != nil {
		return nil, err
	}
	rotation, err := buildScopedRoleAssignmentRotationEvidence(previous, successor, predecessor, head,
		RotationTask{EpochRecord: record, Recipients: recipients}, epoch.Principal, history)
	if err != nil || rotation == nil {
		return nil, err
	}
	evidence := &ScopedRoleAssignmentReadEvidence{Record: rotation.Record, Assignment: rotation.Assignment, PreviousSignerTextPolicy: rotation.PreviousTextPolicy}
	target := head.Draft.ResourceChange.RolesEdit.Change.TargetProfile
	if viewer.ProfileID != target {
		if !retainedPersonalDenyReader(previous, successor, record, viewer) {
			return nil, nil
		}
		// The remaining viewer verifies the assignment's authority without
		// receiving the changed profile's device/recovery inventory.
		if _, opened := evidence.Assignment.Target.Opening["keys"]; opened {
			var seed [32]byte
			if _, err := hex.Decode(seed[:], []byte(predecessor.Draft.TextProjectionSeed)); err != nil {
				return nil, ErrPolicyConflict
			}
			opening := previous.profileRoleAuthority(seed, previous.Members[target], scopedRoleKeys(previous)[target])
			parts, err := opening.parts()
			if err != nil {
				return nil, err
			}
			delete(evidence.Assignment.Target.Opening, "keys")
			delete(evidence.Assignment.Target.Opening, "keysSalt")
			if evidence.Assignment.Target.Unopened == nil {
				evidence.Assignment.Target.Unopened = make(map[string]string)
			}
			evidence.Assignment.Target.Unopened["keys"] = parts.Keys
		}
		if viewer == epoch.Principal {
			evidence.PreviousViewerTextPolicy = evidence.PreviousSignerTextPolicy
			return evidence, nil
		}
	} else {
		evidence.SuccessorViewerPolicy, err = textChannelDisclosure(successor, head, channel, viewer.DeviceID, history, 0)
		if err != nil {
			return nil, err
		}
		if evidence.SuccessorViewerPolicy == nil || evidence.SuccessorViewerPolicy.Recipient == nil {
			return nil, ErrPolicyConflict
		}
	}
	if previous.canLoadEpoch(viewer, channel, LiveEpoch) {
		evidence.PreviousViewerTextPolicy, err = textChannelDisclosure(previous, predecessor, channel, viewer.DeviceID, history, 0)
		if err != nil {
			return nil, err
		}
	}
	return evidence, nil
}
