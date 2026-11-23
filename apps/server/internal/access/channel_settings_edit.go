package access

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"reflect"
	"strconv"
)

const EditScopedChannelSettings = "channel.settings.scoped"

var ErrChannelSettingsEditProof = errors.New("invalid protected channel settings editor proof")

type PolicyChannelSettingsEdit struct {
	CutoverDigest          string
	PreviousSettingsDigest string
	EditorProof            string
	ServerKey              string
}

type ChannelSettingsEditEvidence struct {
	Digest      string                     `json:"digest"`
	OperationID string                     `json:"operationId"`
	Revision    int64                      `json:"revision"`
	PolicyHead  string                     `json:"policyHead"`
	Settings    *ChannelSettings           `json:"settings"`
	EditorProof string                     `json:"editorProof"`
	Authority   ChannelOrderAuthorityProof `json:"authority"`
}

// DispatchChannelSettingsEditEvidence confirms the editor's own current
// change against the preceding channel commitment. It sends no new global
// policy commitment and no data about other channels.
func (s *Store) DispatchChannelSettingsEditEvidence(ctx context.Context, resolve ResolveSession, channel, digest string,
	cache *TextChannelPolicyProofCache, deliver func(*ChannelSettingsEditEvidence) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if _, err := state.checkScopedChannelEdit(actor, channel); err != nil {
			return err
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		change := head.Draft.ResourceChange
		if head.Digest != digest || head.Principal != actor || head.Draft.Action != EditScopedChannelSettings ||
			change == nil || change.ID != channel {
			return deliver(nil)
		}
		previous, predecessor, err := readPrecedingPolicyState(ctx, conn, head.Draft)
		if err != nil {
			return err
		}
		if change.Settings == nil || change.SettingsEdit == nil || !reflect.DeepEqual(change.Settings, state.Channels[channel].Settings) {
			return ErrPolicyConflict
		}
		authority, err := orderAuthorityDisclosure(previous, predecessor, channel, actor.DeviceID, &cache.history)
		if err != nil {
			return err
		}
		return deliver(&ChannelSettingsEditEvidence{Digest: digest, OperationID: head.Draft.OperationID, Revision: head.Draft.Revision,
			PolicyHead: predecessor.Digest, Settings: change.Settings, EditorProof: change.SettingsEdit.EditorProof, Authority: *authority})
	})
}

func (s State) checkScopedChannelEdit(actor Principal, channelID string) (Channel, error) {
	channel, exists := s.Channels[channelID]
	if !s.PolicyAnchored || !s.hasPolicyDevice(actor) || !exists || !s.CanDeliver(actor.ProfileID, channelID, 0) ||
		s.CheckGrant(s.Members[actor.ProfileID], s.scope(channel), "channel.edit", 0) != Allowed {
		return Channel{}, ChannelRestricted
	}
	return channel, nil
}

func (s State) checkScopedChannelSettings(actor Principal, draft PolicyDraft, head PolicyProof) (Channel, error) {
	change := draft.ResourceChange
	if draft.Action != EditScopedChannelSettings || change == nil || change.Settings == nil || change.SettingsEdit == nil ||
		*change != (PolicyResourceChange{ID: change.ID, Settings: change.Settings, SettingsEdit: change.SettingsEdit}) ||
		!validRotationID(change.ID) || !isDigest(change.SettingsEdit.CutoverDigest) ||
		!validRecoveryProof(change.SettingsEdit.EditorProof, ed25519.SignatureSize) ||
		!validRecoveryProof(change.SettingsEdit.ServerKey, ed25519.PublicKeySize) {
		return Channel{}, InvalidAction
	}
	if head.Draft.TextProjectionVersion < ChannelSettingsProjectionVersion {
		return Channel{}, ErrPolicyAttestationUnavailable
	}
	channel, err := s.checkScopedChannelEdit(actor, change.ID)
	if err != nil {
		return Channel{}, err
	}
	if !change.Settings.valid(channel.Kind) {
		return Channel{}, InvalidPolicy
	}
	digest, err := channelSettingsDigest(channel.Settings)
	if err != nil {
		return Channel{}, err
	}
	if digest != change.SettingsEdit.PreviousSettingsDigest {
		return Channel{}, ErrPolicyConflict
	}
	return channel, nil
}

// VerifyScopedChannelSettingsEdit verifies a device signature over a single
// channel, its exact policy predecessor, and the old and proposed settings.
func VerifyScopedChannelSettingsEdit(ctx context.Context, query SessionQuery, serverID string, actor Principal, draft PolicyDraft) error {
	state, head, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return err
	}
	channel, err := state.checkScopedChannelSettings(actor, draft, head)
	if err != nil {
		return err
	}
	change := draft.ResourceChange
	proposed, err := channelSettingsDigest(change.Settings)
	if err != nil {
		return err
	}
	frame, err := SignatureFrame("pawtalk-protected-channel-settings-edit-v1", serverID, change.SettingsEdit.CutoverDigest,
		actor.ProfileID, actor.DeviceID, draft.OperationID, strconv.FormatInt(head.Draft.Revision, 10), head.Digest,
		change.ID, channel.Kind, channel.CategoryID, change.SettingsEdit.PreviousSettingsDigest, proposed)
	if err != nil {
		return err
	}
	key := parseScopeAuthorityKey(state.PolicyDevices[actor.DeviceID].PublicKey)
	if !signingKeyMatches(actor.DeviceID, state.PolicyDevices[actor.DeviceID].PublicKey) ||
		!verifyScopeAuthoritySignature(key, frame, change.SettingsEdit.EditorProof) {
		return ErrChannelSettingsEditProof
	}
	return nil
}

func (s *Store) CommitScopedChannelSettingsEdit(ctx context.Context, resolve ResolveSession, intent PolicyDraft,
	sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	if intent.Action != EditScopedChannelSettings || intent.ResourceChange == nil ||
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
	if _, err := state.checkScopedChannelEdit(actor, intent.ResourceChange.ID); err != nil {
		return PolicyProof{}, err
	}
	prior, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE operation_id=?`, intent.OperationID))
	if err == nil {
		if prior.Principal != actor || prior.Draft.Action != EditScopedChannelSettings || prior.Draft.PreviousDigest != intent.PreviousDigest ||
			!reflect.DeepEqual(prior.Draft.ResourceChange, intent.ResourceChange) {
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
