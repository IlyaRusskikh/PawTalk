package access

import (
	"context"
	"encoding/hex"
	"maps"
	"slices"
)

const ConfirmPolicyRecovery = "recovery.confirm"

func isRecoveryPolicyAction(action string) bool {
	return action == EnrollPolicyRecovery || action == ConfirmPolicyRecovery || action == RecoverPolicyDevice
}

type RecoveryPolicyConfirmation struct {
	RecoveryID    string
	CutoverDigest string
	ServerKey     string
	Nonce         string
	ExpiresAt     int64
	Items         []RecoveryReadyItem
	RecoveryProof string
	DeviceProof   string
}

type RecoveryReadyItem struct {
	ChannelID     string
	Purpose       string
	Generation    uint64
	EpochDigest   string
	PackageDigest string
	OpeningKey    string
	OpeningProof  string
	RecoveryProof string
}

func (confirmation RecoveryPolicyConfirmation) valid() bool {
	if !isDigest(confirmation.RecoveryID) || !isDigest(confirmation.CutoverDigest) || !isDigest(confirmation.Nonce) ||
		!validRecoveryProof(confirmation.ServerKey, 32) || !validRecoveryProof(confirmation.RecoveryProof, 64) ||
		!validRecoveryProof(confirmation.DeviceProof, 64) || confirmation.ExpiresAt <= 0 || confirmation.ExpiresAt > maxInviteDate ||
		confirmation.Items == nil || len(confirmation.Items) > maxRecoveryCoverageItems {
		return false
	}
	for _, item := range confirmation.Items {
		if !validRotationID(item.ChannelID) || (item.Purpose != ArchiveEpoch && item.Purpose != LiveEpoch) ||
			item.Generation == 0 || item.Generation >= 1<<53 || !isDigest(item.EpochDigest) || !isDigest(item.PackageDigest) ||
			!isDigest(item.OpeningKey) || !validRecoveryProof(item.OpeningProof, 64) || !validRecoveryProof(item.RecoveryProof, 64) {
			return false
		}
		key, _ := hex.DecodeString(item.OpeningKey)
		if !ValidRecoveryEpochOpeningKey(key) {
			return false
		}
	}
	return true
}

func checkRecoveryConfirmationScope(state State, profile string, items []RecoveryReadyItem) error {
	index := 0
	for _, channel := range slices.Sorted(maps.Keys(state.Channels)) {
		for _, purpose := range []string{ArchiveEpoch, LiveEpoch} {
			if !canReadRecoveryEpoch(state, profile, channel, purpose) {
				continue
			}
			if index >= len(items) || items[index].ChannelID != channel || items[index].Purpose != purpose {
				return ErrRecoveryCoverageChanged
			}
			index++
		}
	}
	if index != len(items) {
		return ErrRecoveryCoverageChanged
	}
	return nil
}

func (s *State) applyRecoveryConfirmation(actor Principal, change PolicyResourceChange) error {
	confirmation := change.RecoveryConfirmation
	if confirmation == nil || change != (PolicyResourceChange{ID: actor.ProfileID, RecoveryConfirmation: confirmation}) || !confirmation.valid() {
		return InvalidAction
	}
	identity, err := currentRecoveryIdentity(*s, actor, 0)
	if err != nil {
		return err
	}
	if identity.ID != confirmation.RecoveryID {
		return ErrPolicyConflict
	}
	if err := checkRecoveryConfirmationScope(*s, actor.ProfileID, confirmation.Items); err != nil {
		return err
	}
	if s.RecoveryReady == nil {
		s.RecoveryReady = make(map[string]bool)
	}
	s.RecoveryReady[actor.ProfileID] = true
	return nil
}

// CommitRecoveryConfirmation marks a still-active recovery identity ready
// only after its exact current packet coverage is verified in the policy
// transaction. Exact authenticated retries can return their original receipt.
func (s *Store) CommitRecoveryConfirmation(ctx context.Context, resolve ResolveSession, intent PolicyDraft,
	verifyIntent VerifyPolicyDraft, sign SignServerPolicyDraft, verify VerifyPolicyDraft, verifyEpoch VerifyEpochRecord) (PolicyProof, error) {
	if intent.Action != ConfirmPolicyRecovery || verifyEpoch == nil || intent.ResourceChange == nil ||
		intent.ResourceChange.RecoveryConfirmation == nil || !intent.ResourceChange.RecoveryConfirmation.valid() {
		return PolicyProof{}, InvalidAction
	}
	if change := *intent.ResourceChange; change != (PolicyResourceChange{ID: change.ID, RecoveryConfirmation: change.RecoveryConfirmation}) {
		return PolicyProof{}, InvalidAction
	}
	return s.commitVerifiedMemberTransition(ctx, resolve, intent, intent.ResourceChange.RecoveryConfirmation.ExpiresAt, verifyIntent, sign, verify, verifyEpoch)
}

func ReadActiveRecoveryIdentity(ctx context.Context, query SessionQuery, actor Principal, now int64) (RecoveryIdentity, error) {
	state, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return RecoveryIdentity{}, err
	}
	return currentRecoveryIdentity(state, actor, now)
}

func ReadRecoveryConfirmationIdentity(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) (RecoveryIdentity, error) {
	state, _, err := readRecoveryConfirmationBasis(ctx, query, draft)
	if err != nil {
		return RecoveryIdentity{}, err
	}
	identity, err := currentRecoveryIdentity(state, actor, 0)
	if err != nil {
		return RecoveryIdentity{}, err
	}
	if draft.ResourceChange.ID != actor.ProfileID || identity.ID != draft.ResourceChange.RecoveryConfirmation.RecoveryID {
		return RecoveryIdentity{}, ErrPolicyConflict
	}
	return identity, nil
}

// VerifyHistoricalRecoveryConfirmationEvidence rechecks the immutable
// packet witnesses at startup, without using current generations or clocks.
func VerifyHistoricalRecoveryConfirmationEvidence(ctx context.Context, query RecoveryEvidenceQuery, actor Principal, draft PolicyDraft,
	serverID string, verifyEpoch VerifyEpochRecord) error {
	state, head, err := readRecoveryConfirmationBasis(ctx, query, draft)
	if err != nil {
		return err
	}
	confirmation := *draft.ResourceChange.RecoveryConfirmation
	if draft.ResourceChange.ID != actor.ProfileID || !confirmation.valid() {
		return InvalidAction
	}
	return VerifyRecoveryConfirmationEvidence(ctx, query, state, actor, head, serverID, confirmation, verifyEpoch, 0, false)
}

func readRecoveryConfirmationBasis(ctx context.Context, query SessionQuery, draft PolicyDraft) (State, PolicyProof, error) {
	if draft.Action != ConfirmPolicyRecovery || draft.ResourceChange == nil || draft.ResourceChange.RecoveryConfirmation == nil {
		return State{}, PolicyProof{}, InvalidAction
	}
	return readPrecedingPolicyState(ctx, query, draft)
}

func readPrecedingPolicyState(ctx context.Context, query SessionQuery, draft PolicyDraft) (State, PolicyProof, error) {
	if draft.Revision <= 1 || !isDigest(draft.PreviousDigest) {
		return State{}, PolicyProof{}, InvalidAction
	}
	head, err := readStoredPolicyProof(ctx, query, query.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE revision=? AND digest=?`, draft.Revision-1, draft.PreviousDigest))
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	state, revision, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy_proofs WHERE revision=?",
		head.Draft.Revision))
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	// The canonical signed snapshot omits the transient anchor flag.
	state.PolicyAnchored = true
	if err := checkPolicyHead(state, revision, head); err != nil {
		return State{}, PolicyProof{}, err
	}
	return state, head, nil
}
