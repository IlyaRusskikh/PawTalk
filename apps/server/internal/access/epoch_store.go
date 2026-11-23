package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"math"
)

var ErrEpochStale = errors.New("protected key generation unavailable or stale")
var ErrEpochConflict = errors.New("protected key generation conflict")

type EpochRecord struct {
	ChannelID               string
	Purpose                 string
	Generation              uint64
	Revision                int64
	PolicyDigest            string
	PreviousDigest          string
	KeyID                   string
	TaskID                  string
	LeaseID                 string
	PackagesDigest          string
	ArchiveThrough          uint64
	ArchiveLinksDigest      string
	ArchiveWrapKey          string `json:",omitempty"`
	LiveTransitionDigest    string `json:",omitempty"`
	ArchiveTransitionDigest string `json:",omitempty"`
	Signature               []byte
}

func (r EpochRecord) ValidArchiveWrapKey() bool {
	return r.ArchiveWrapKey == "" || (r.Purpose == ArchiveEpoch &&
		r.ArchiveWrapKey != r.KeyID && validRecipientKey(r.ArchiveWrapKey))
}

func (r EpochRecord) ValidTransitionDigests() bool {
	return (r.LiveTransitionDigest == "" || r.Purpose == LiveEpoch && isDigest(r.LiveTransitionDigest)) &&
		(r.ArchiveTransitionDigest == "" || r.Purpose == ArchiveEpoch && r.ArchiveWrapKey != "" && r.ValidArchiveWrapKey() &&
			isDigest(r.ArchiveTransitionDigest))
}

// QueueArchiveWrapUpgrades leaves legacy signed epochs immutable. A normal
// archive rotation publishes a wrapping address and links the previous head.
func QueueArchiveWrapUpgrades(ctx context.Context, tx *sql.Tx, now int64) error {
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	for channel, generation := range state.ArchiveHeads {
		var key, digest string
		var raw []byte
		if err := tx.QueryRowContext(ctx, `SELECT key_id,digest,record FROM protected_epochs
			WHERE channel_id=? AND purpose='archive' AND generation=?`, channel, generation).Scan(&key, &digest, &raw); err != nil {
			return err
		}
		proof, err := decodeEpoch(raw, channel, ArchiveEpoch, key, digest, generation)
		if err != nil {
			return err
		}
		if proof.Record.ArchiveWrapKey == "" {
			// Format upgrades have no initiating user. All eligible archive
			// readers can claim work immediately.
			if err := enqueueRotation(ctx, tx, channel, ArchiveEpoch, revision, "", now-rotationPriorityMillis); err != nil {
				return err
			}
		}
	}
	return nil
}

// QueueRecoveryOpeningUpgrades leaves previously signed manifests intact.
// Only currently eligible runtime recipients with old 80-byte packages need
// another epoch. Pending rotation rows and their leases are preserved.
func QueueRecoveryOpeningUpgrades(ctx context.Context, tx *sql.Tx, now int64) error {
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	if len(state.RecoveryIdentities) == 0 {
		return nil
	}
	runtimeRecipients := make(map[string]KeyRecipient, len(state.RecoveryIdentities))
	for profile, recovery := range state.RecoveryIdentities {
		recipient := state.KeyRecipients[recovery.ID]
		if recipient == (KeyRecipient{ProfileID: profile, Kind: "recovery", PublicKey: recovery.AgreementKey}) {
			runtimeRecipients[recovery.ID] = recipient
		}
	}
	for channelID, channel := range state.Channels {
		if channel.Kind != "text" {
			continue
		}
		readers := state.channelReaders(channel)
		for _, purpose := range []string{LiveEpoch, ArchiveEpoch} {
			generation := state.currentGeneration(channelID, purpose)
			if generation == 0 {
				continue
			}
			needsUpgrade, err := hasLegacyRuntimeRecoveryPackage(ctx, tx, channelID, purpose, generation, runtimeRecipients, readers)
			if err != nil {
				return err
			}
			if needsUpgrade {
				if err := enqueueRotation(ctx, tx, channelID, purpose, revision, "", now); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func hasLegacyRuntimeRecoveryPackage(ctx context.Context, tx *sql.Tx, channel, purpose string, generation uint64,
	runtimeRecipients map[string]KeyRecipient, readers map[string]bool) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT recipient_id,recipient_key FROM protected_epoch_packages
		WHERE channel_id=? AND purpose=? AND generation=? AND length(ciphertext)=?`,
		channel, purpose, generation, EpochPackageSize)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, key string
		if err := rows.Scan(&id, &key); err != nil {
			return false, err
		}
		recipient, runtime := runtimeRecipients[id]
		full, eligible := readers[recipient.ProfileID]
		if runtime && recipient.PublicKey == key && eligible && (purpose == LiveEpoch || full) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// An epoch verifier authenticates the rotation signature.
type VerifyEpochRecord func(context.Context, SessionQuery, Principal, EpochRecord) error

// PolicyDigest commits to the access snapshot independent of message and epoch
// writes. Policy revision is signed separately. This is an internal encoding.
func (s State) PolicyDigest() (string, error) {
	raw, err := s.policySnapshotBytes()
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:]), nil
}

func (s State) policySnapshotBytes() ([]byte, error) {
	s.EpochWindows = nil
	s.ArchiveHeads = nil
	s.PolicyAnchored = false
	s.Channels = maps.Clone(s.Channels)
	for id, channel := range s.Channels {
		channel.NextPosition = 0
		s.Channels[id] = channel
	}
	return json.Marshal(s)
}

func (s State) recipients() map[string]map[string]bool {
	recipients := make(map[string]map[string]bool)
	for id, channel := range s.Channels {
		if channel.Kind == "text" {
			recipients[id] = s.channelReaders(channel)
		}
	}
	return recipients
}

func (s State) channelReaders(channel Channel) map[string]bool {
	profiles := make(map[string]bool)
	scope := s.scope(channel)
	for profile, subject := range s.Members {
		if s.CheckGrant(subject, scope, ChannelView, 0) == Allowed {
			profiles[profile] = s.CheckGrant(subject, scope, "history.full", 0) == Allowed
		}
	}
	return profiles
}

func (s *State) updateEpochWindows(before map[string]map[string]bool, now int64) {
	maps.DeleteFunc(s.ArchiveHeads, func(channel string, _ uint64) bool {
		_, exists := s.Channels[channel]
		return !exists
	})
	for channel, window := range s.EpochWindows {
		if _, exists := s.Channels[channel]; !exists {
			delete(s.EpochWindows, channel)
			continue
		}
		scope := s.scope(s.Channels[channel])
		for profile, subject := range s.Members {
			hadArchive, wasReader := before[channel][profile]
			canRead := s.CheckGrant(subject, scope, ChannelView, 0) == Allowed
			hasArchive := canRead && s.CheckGrant(subject, scope, "history.full", 0) == Allowed
			if wasReader && (!canRead || hadArchive && !hasArchive) {
				window = window.Revoke(now)
			}
			if !wasReader && canRead && !hasArchive {
				window.NeedsFresh = true
			}
		}
		s.EpochWindows[channel] = window
	}
}

func isDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && hex.EncodeToString(decoded) == value
}

func (s *Store) CommitEpoch(ctx context.Context, resolve ResolveSession, verify VerifyEpochRecord, record EpochRecord, packages []EpochPackage, links []ArchiveLink) error {
	if verify == nil || record.Generation == 0 || record.Generation >= math.MaxInt64 || len(record.Signature) != 64 ||
		(record.Purpose != LiveEpoch && record.Purpose != ArchiveEpoch) ||
		!isDigest(record.KeyID) || !isDigest(record.PolicyDigest) || !isDigest(record.PackagesDigest) || !record.ValidArchiveWrapKey() ||
		!record.ValidTransitionDigests() || !validRotationID(record.TaskID) || !validRotationID(record.LeaseID) {
		return InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	principal, err := resolve(ctx, tx)
	if err != nil {
		return err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	if revision != record.Revision {
		return ErrPolicyConflict
	}
	channel, exists := state.Channels[record.ChannelID]
	if !exists || channel.Kind != "text" || !state.CanDeliver(principal.ProfileID, record.ChannelID, 0) {
		return ChannelRestricted
	}
	recipient := state.KeyRecipients[principal.DeviceID]
	if recipient.Kind != "device" || recipient.ProfileID != principal.ProfileID || record.Purpose == ArchiveEpoch &&
		state.CheckGrant(state.Members[principal.ProfileID], state.scope(channel), "history.full", 0) != Allowed {
		return ErrRotationLease
	}
	policyDigest, err := state.PolicyDigest()
	if err != nil {
		return err
	}
	if policyDigest != record.PolicyDigest {
		return ErrPolicyConflict
	}
	current := state.currentGeneration(record.ChannelID, record.Purpose)
	var previous string
	if current != 0 {
		var raw []byte
		if err := tx.QueryRowContext(ctx, "SELECT digest,record FROM protected_epochs WHERE channel_id=? AND purpose=? AND generation=?",
			record.ChannelID, record.Purpose, current).Scan(&previous, &raw); err != nil {
			return err
		}
		var proof EpochProof
		if err := json.Unmarshal(raw, &proof); err != nil {
			return err
		}
		if proof.Record.ArchiveWrapKey != "" && record.ArchiveWrapKey == "" {
			return ErrEpochConflict
		}
	}
	if record.Generation != current+1 || record.PreviousDigest != previous {
		return ErrEpochConflict
	}
	through, err := verifyRotationLease(ctx, tx, principal, record, s.now().UnixMilli())
	if err != nil {
		return err
	}
	if record.ArchiveThrough != through {
		return ErrEpochConflict
	}
	if err := verify(ctx, tx, principal, record); err != nil {
		return err
	}
	recipients, err := state.rotationRecipients(record.ChannelID, record.Purpose)
	if err != nil {
		return err
	}
	var inviteBatchBase int64
	if record.LiveTransitionDigest != "" || record.ArchiveTransitionDigest != "" {
		if err := checkEpochTransition(ctx, tx, state, principal, record, recipients, verify, &inviteBatchBase); err != nil {
			return err
		}
	}
	if err := state.checkEpochPackages(record.PackagesDigest, record.Purpose, recipients, packages); err != nil {
		return err
	}
	if err := checkArchiveLinks(ctx, tx, state, record, links); err != nil {
		return err
	}
	raw, err := json.Marshal(storedEpochProof{Principal: principal, Record: record, InviteAdmissionBaseRevision: inviteBatchBase})
	if err != nil {
		return err
	}
	digest := sha256.Sum256(record.Signature)
	result, err := tx.ExecContext(ctx, `INSERT INTO protected_epochs (channel_id,purpose,generation,key_id,task_id,digest,record)
	    VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, record.ChannelID, record.Purpose, record.Generation, record.KeyID,
		record.TaskID, hex.EncodeToString(digest[:]), raw)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrEpochConflict
	}
	for _, item := range packages {
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_epoch_packages(channel_id,generation,recipient_id,recipient_key,purpose,ciphertext)
		    VALUES(?,?,?,?,?,?)`, record.ChannelID, record.Generation, item.RecipientID, recipients[item.RecipientID].PublicKey,
			item.Purpose, item.Ciphertext); err != nil {
			return err
		}
	}
	for _, link := range links {
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_archive_links
		    (channel_id,archive_generation,purpose,target_generation,target_key_id,ciphertext) VALUES(?,?,?,?,?,?)`,
			record.ChannelID, record.Generation, link.Purpose, link.Generation, link.KeyID, link.Ciphertext); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_rotation_tasks WHERE task_id=?", record.TaskID); err != nil {
		return err
	}
	if record.Purpose == LiveEpoch {
		if state.EpochWindows == nil {
			state.EpochWindows = make(map[string]EpochWindow)
		}
		state.EpochWindows[record.ChannelID] = state.EpochWindows[record.ChannelID].Rotate()
	} else {
		if state.ArchiveHeads == nil {
			state.ArchiveHeads = make(map[string]uint64)
		}
		state.ArchiveHeads[record.ChannelID] = record.Generation
	}
	if record.Purpose == LiveEpoch || record.ArchiveThrough < state.EpochWindows[record.ChannelID].Current {
		if err := enqueueRotation(ctx, tx, record.ChannelID, ArchiveEpoch, revision, principal.ProfileID, s.now().UnixMilli()); err != nil {
			return err
		}
	}
	snapshot, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_policy SET snapshot=? WHERE id=1", snapshot); err != nil {
		return err
	}
	return tx.Commit()
}

func VerifyEpochRecipient(ctx context.Context, query SessionQuery, principal Principal, channel string, generation uint64) error {
	state, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	recipient := state.KeyRecipients[principal.DeviceID]
	if recipient.Kind != "device" || recipient.ProfileID != principal.ProfileID {
		return ErrEpochStale
	}
	var exists bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_epoch_packages
	    WHERE channel_id=? AND generation=? AND recipient_id=? AND recipient_key=? AND purpose='live')`,
		channel, generation, principal.DeviceID, recipient.PublicKey).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrEpochStale
	}
	return nil
}

type EpochProof struct {
	Principal                   Principal
	Record                      EpochRecord
	SigningPolicy               *TextChannelPolicyDisclosure      `json:"signingPolicy,omitempty"`
	LiveInviteAdmission         *InviteAdmissionReadEvidence      `json:"liveInviteAdmission,omitempty"`
	ArchiveInviteAdmission      *InviteAdmissionReadEvidence      `json:"archiveInviteAdmission,omitempty"`
	LiveInviteAdmissions        *InviteAdmissionBatchReadEvidence `json:"liveInviteAdmissions,omitempty"`
	ArchiveInviteAdmissions     *InviteAdmissionBatchReadEvidence `json:"archiveInviteAdmissions,omitempty"`
	ArchivePersonalDeny         *PersonalDenyReadEvidence         `json:"archivePersonalDeny,omitempty"`
	ArchiveRoleViewDeny         *RoleViewDenyReadEvidence         `json:"archiveRoleViewDeny,omitempty"`
	RoleAssignment              *ScopedRoleAssignmentReadEvidence `json:"roleAssignment,omitempty"`
	inviteAdmissionBaseRevision int64
}

type storedEpochProof struct {
	Principal                   Principal
	Record                      EpochRecord
	InviteAdmissionBaseRevision int64 `json:"inviteAdmissionBaseRevision,omitempty"`
}

func ReadMessageEpoch(ctx context.Context, query SessionQuery, channel, key string, now int64) (EpochProof, error) {
	state, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return EpochProof{}, err
	}
	proof, err := readEpoch(ctx, query, channel, LiveEpoch, key)
	if err != nil {
		return EpochProof{}, err
	}
	if !state.EpochWindows[channel].Accepts(proof.Record.Generation, now) {
		return EpochProof{}, ErrEpochStale
	}
	return proof, nil
}

func readEpoch(ctx context.Context, query SessionQuery, channel, purpose, key string) (EpochProof, error) {
	var proof EpochProof
	var generation uint64
	var raw []byte
	var digest string
	err := query.QueryRowContext(ctx, "SELECT generation,digest,record FROM protected_epochs WHERE channel_id=? AND purpose=? AND key_id=?", channel, purpose, key).
		Scan(&generation, &digest, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return proof, ErrEpochStale
	}
	if err != nil {
		return proof, err
	}
	return decodeEpoch(raw, channel, purpose, key, digest, generation)
}

func decodeEpoch(raw []byte, channel, purpose, key, digest string, generation uint64) (EpochProof, error) {
	var stored storedEpochProof
	if err := json.Unmarshal(raw, &stored); err != nil {
		return EpochProof{}, err
	}
	proof := EpochProof{Principal: stored.Principal, Record: stored.Record, inviteAdmissionBaseRevision: stored.InviteAdmissionBaseRevision}
	hash := sha256.Sum256(proof.Record.Signature)
	if len(proof.Record.Signature) != 64 || hex.EncodeToString(hash[:]) != digest {
		return proof, ErrEpochConflict
	}
	if proof.Record.ChannelID != channel || proof.Record.Purpose != purpose || proof.Record.KeyID != key ||
		proof.Record.Generation != generation || !proof.Record.ValidArchiveWrapKey() || !proof.Record.ValidTransitionDigests() {
		return proof, ErrEpochConflict
	}
	return proof, nil
}
