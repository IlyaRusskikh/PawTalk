package access

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"maps"
	"slices"
	"strings"
)

const rotationPriorityMillis = 5_000
const rotationLeaseMillis = 15_000
const zeroKey = "0000000000000000000000000000000000000000000000000000000000000000"
const LiveEpoch = "live"
const ArchiveEpoch = "archive"

var ErrRotationUnavailable = errors.New("protected rotation unavailable")
var ErrRotationLease = errors.New("protected rotation lease expired or unavailable")
var ErrEpochRecipients = errors.New("protected epoch recipient packages do not match policy")

type KeyRecipient struct {
	ProfileID string
	Kind      string
	PublicKey string
}

type RotationTask struct {
	EpochRecord
	LeaseUntil              int64
	Recipients              map[string]KeyRecipient
	ArchiveTargets          []ArchiveTarget
	TextPolicy              *TextChannelPolicyDisclosure          `json:"textPolicy,omitempty"`
	RecipientSalt           string                                `json:"recipientSalt,omitempty"`
	RotationProfileOpenings map[string]RotationProfileOpening     `json:"rotationProfileOpenings,omitempty"`
	LivePersonalDeny        *PersonalDenyRotationEvidence         `json:"livePersonalDeny,omitempty"`
	ArchivePersonalDeny     *PersonalDenyRotationEvidence         `json:"archivePersonalDeny,omitempty"`
	RoleViewDeny            *RoleViewDenyRotationEvidence         `json:"roleViewDeny,omitempty"`
	RoleAssignment          *ScopedRoleAssignmentRotationEvidence `json:"roleAssignment,omitempty"`
	InviteAdmission         *InviteAdmissionRotationEvidence      `json:"inviteAdmission,omitempty"`
	InviteAdmissions        *InviteAdmissionBatchEvidence         `json:"inviteAdmissions,omitempty"`
	OpeningProofRecipients  []string                              `json:"openingProofRecipients,omitempty"`
}

type PendingRotation struct {
	ChannelID string `json:"channelId"`
	Purpose   string `json:"purpose"`
}

func randomRotationID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

func validRotationID(id string) bool {
	return len(id) == 32 && strings.Trim(id, "0123456789abcdef") == ""
}

func syncRotationTasks(ctx context.Context, tx *sql.Tx, state State, before map[string]map[string]bool, keyChanges map[string]bool,
	revision int64, initiator string, now int64) error {
	after := state.recipients()
	for id := range before {
		if _, exists := after[id]; !exists {
			if _, err := tx.ExecContext(ctx, "DELETE FROM protected_rotation_tasks WHERE channel_id=?", id); err != nil {
				return err
			}
		}
	}
	// An older lease was issued against a different policy revision.
	if _, err := tx.ExecContext(ctx, `UPDATE protected_rotation_tasks SET revision=?,lease_device='',lease_id='',lease_until=0,archive_through=0`,
		revision); err != nil {
		return err
	}
	for id, readers := range after {
		for _, purpose := range []string{LiveEpoch, ArchiveEpoch} {
			if state.currentGeneration(id, purpose) != 0 && !keyChanges[id] && maps.Equal(before[id], readers) {
				continue
			}
			if err := enqueueRotation(ctx, tx, id, purpose, revision, initiator, now); err != nil {
				return err
			}
		}
	}
	return nil
}

func enqueueRotation(ctx context.Context, tx *sql.Tx, channel, purpose string, revision int64, initiator string, now int64) error {
	task, err := randomRotationID()
	if err != nil {
		return err
	}
	priorityUntil := now
	if initiator != "" {
		priorityUntil += rotationPriorityMillis
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_rotation_tasks (channel_id,purpose,task_id,revision,initiator,priority_until)
	    VALUES(?,?,?,?,?,?) ON CONFLICT(channel_id,purpose) DO NOTHING`, channel, purpose, task, revision, initiator, priorityUntil)
	return err
}

func (s State) currentGeneration(channel, purpose string) uint64 {
	if purpose == ArchiveEpoch {
		return s.ArchiveHeads[channel]
	}
	return s.EpochWindows[channel].Current
}

func (s State) rotationRecipients(channel, purpose string) (map[string]KeyRecipient, error) {
	readers := s.channelReaders(s.Channels[channel])
	recipients := make(map[string]KeyRecipient)
	for id, recipient := range s.KeyRecipients {
		full, allowed := readers[recipient.ProfileID]
		if allowed && (purpose == LiveEpoch || full) {
			recipients[id] = recipient
		}
	}
	if len(recipients) == 0 || len(recipients) > 8192 {
		return nil, ErrEpochRecipients
	}
	return recipients, nil
}

func (s State) requiresEpochOpeningProof(id string, recipient KeyRecipient) bool {
	return recipient.Kind == "recovery" && s.RecoveryIdentities[recipient.ProfileID].ID == id
}

func (s *Store) ClaimRotation(ctx context.Context, resolve ResolveSession, channel, purpose string) (RotationTask, error) {
	return s.claimRotation(ctx, resolve, channel, purpose, false, "", nil)
}

func (s *Store) claimRotation(ctx context.Context, resolve ResolveSession, channel, purpose string, useRecovery bool, expectedLease string,
	transition *TextChannelPolicyProofCache) (RotationTask, error) {
	var task RotationTask
	if purpose != LiveEpoch && purpose != ArchiveEpoch {
		return task, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return task, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return task, err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return task, err
	}
	device := state.KeyRecipients[actor.DeviceID]
	if !state.CanDeliver(actor.ProfileID, channel, 0) || device.Kind != "device" || device.ProfileID != actor.ProfileID {
		return task, ChannelRestricted
	}
	subject := state.Members[actor.ProfileID]
	if purpose == ArchiveEpoch && state.CheckGrant(subject, state.scope(state.Channels[channel]), "history.full", 0) != Allowed {
		return task, ErrRotationUnavailable
	}
	var initiator, leaseDevice string
	var priorityUntil int64
	err = tx.QueryRowContext(ctx, `SELECT task_id,revision,initiator,priority_until,lease_device,lease_id,lease_until,archive_through
	    FROM protected_rotation_tasks WHERE channel_id=? AND purpose=?`, channel, purpose).Scan(&task.TaskID, &task.Revision, &initiator,
		&priorityUntil, &leaseDevice, &task.LeaseID, &task.LeaseUntil, &task.ArchiveThrough)
	if errors.Is(err, sql.ErrNoRows) {
		return RotationTask{}, ErrRotationUnavailable
	}
	if err != nil {
		return RotationTask{}, err
	}
	if revision != task.Revision {
		return RotationTask{}, ErrPolicyConflict
	}
	now := s.now().UnixMilli()
	if expectedLease != "" && (task.LeaseID != expectedLease || task.LeaseUntil <= now || actor.DeviceID != leaseDevice) {
		return RotationTask{}, ErrRotationLease
	}
	if task.LeaseUntil > now && actor.DeviceID != leaseDevice ||
		task.LeaseUntil <= now && now < priorityUntil && actor.ProfileID != initiator {
		return RotationTask{}, ErrRotationLease
	}
	task.Recipients, err = state.rotationRecipients(channel, purpose)
	if err != nil {
		return RotationTask{}, err
	}
	for id, recipient := range task.Recipients {
		if state.requiresEpochOpeningProof(id, recipient) {
			task.OpeningProofRecipients = append(task.OpeningProofRecipients, id)
		}
	}
	slices.Sort(task.OpeningProofRecipients)
	task.PolicyDigest, err = state.PolicyDigest()
	if err != nil {
		return RotationTask{}, err
	}
	task.ChannelID = channel
	task.Purpose = purpose
	task.Generation = state.currentGeneration(channel, purpose) + 1
	if task.Generation > 1 {
		if err := tx.QueryRowContext(ctx, "SELECT digest FROM protected_epochs WHERE channel_id=? AND purpose=? AND generation=?",
			channel, purpose, task.Generation-1).Scan(&task.PreviousDigest); err != nil {
			return RotationTask{}, err
		}
	}
	if purpose == ArchiveEpoch {
		covered, err := previousArchiveCoverage(ctx, tx, channel, task.Generation)
		if err != nil {
			return RotationTask{}, err
		}
		live := state.currentGeneration(channel, LiveEpoch)
		if live == 0 {
			return RotationTask{}, ErrRotationUnavailable
		}
		if covered > live {
			return RotationTask{}, ErrEpochConflict
		}
		if task.LeaseUntil <= now {
			task.ArchiveThrough = min(live, covered+archiveBatchSize)
		}
		if task.ArchiveThrough == 0 || task.ArchiveThrough < covered || task.ArchiveThrough > live ||
			task.ArchiveThrough-covered > archiveBatchSize {
			return RotationTask{}, ErrEpochConflict
		}
		ready, err := hasArchiveRotationSources(ctx, tx, state, actor, channel, task.Generation-1, covered, task.ArchiveThrough, now, useRecovery)
		if err != nil {
			return RotationTask{}, err
		}
		if !ready {
			return RotationTask{}, ErrRotationUnavailable
		}
		task.ArchiveTargets, err = archiveTargets(ctx, tx, channel, task.Generation, covered, task.ArchiveThrough)
		if err != nil {
			return RotationTask{}, err
		}
	}
	if task.LeaseUntil <= now {
		task.LeaseID, err = randomRotationID()
		if err != nil {
			return RotationTask{}, err
		}
		task.LeaseUntil = now + rotationLeaseMillis
		if _, err := tx.ExecContext(ctx, "UPDATE protected_rotation_tasks SET lease_device=?,lease_id=?,lease_until=?,archive_through=? WHERE task_id=?",
			actor.DeviceID, task.LeaseID, task.LeaseUntil, task.ArchiveThrough, task.TaskID); err != nil {
			return RotationTask{}, err
		}
	}
	if transition != nil {
		if err := populateScopedRotation(ctx, tx, state, actor, &task, transition); err != nil {
			return RotationTask{}, err
		}
		if err := checkRotationTransitionAttestations(ctx, tx, task); err != nil {
			return RotationTask{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return RotationTask{}, err
	}
	return task, nil
}

func hasArchiveRotationMaterial(ctx context.Context, query SessionQuery, channel, device, key string,
	previous, covered, through uint64) (bool, error) {
	var count uint64
	err := query.QueryRowContext(ctx, `SELECT COUNT(*) FROM protected_epoch_packages
	    WHERE channel_id=? AND recipient_id=? AND recipient_key=?
	    AND ((purpose='live' AND generation>? AND generation<=?) OR (purpose='archive' AND generation=?))`,
		channel, device, key, covered, through, previous).Scan(&count)
	expected := through - covered
	if previous > 0 {
		expected++
	}
	return count == expected, err
}

func hasArchiveRotationSources(ctx context.Context, query SessionQuery, state State, actor Principal, channel string,
	previous, covered, through uint64, now int64, useRecovery bool) (bool, error) {
	device := state.KeyRecipients[actor.DeviceID]
	ready, err := hasArchiveRotationMaterial(ctx, query, channel, actor.DeviceID, device.PublicKey, previous, covered, through)
	if ready || err != nil || !useRecovery {
		return ready, err
	}
	identity, err := currentRecoveryIdentity(state, actor, now)
	if err != nil || identity.ID == "" {
		return false, err
	}
	targets, err := archiveTargets(ctx, query, channel, previous+1, covered, through)
	if err != nil {
		return false, err
	}
	var basis recoveryEpochBasis
	for _, target := range targets {
		addressed, err := hasAddressedEpochPackage(ctx, query, channel, actor.DeviceID, device.PublicKey, target)
		if err != nil {
			return false, err
		}
		if addressed {
			continue
		}
		packet, err := readRecoveryEpochWitness(ctx, query, state, actor.ProfileID, identity,
			RecoveryCoverageItem{ChannelID: channel, Purpose: target.Purpose, Generation: target.Generation}, &basis)
		if err != nil || packet.packageDigest == "" || packet.epoch.Record.KeyID != target.KeyID {
			return false, err
		}
	}
	return true, nil
}

func hasAddressedEpochPackage(ctx context.Context, query SessionQuery, channel, recipient, publicKey string, target ArchiveTarget) (bool, error) {
	var addressed bool
	err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_epoch_packages
		WHERE channel_id=? AND purpose=? AND generation=? AND recipient_id=? AND recipient_key=?)`,
		channel, target.Purpose, target.Generation, recipient, publicKey).Scan(&addressed)
	return addressed, err
}

// DispatchRotationTask commits a lease before disclosing it, then checks that
// the same policy and lease are still valid under the delivery lock.
func (s *Store) DispatchRotationTask(ctx context.Context, resolve ResolveSession, channel, purpose string,
	scoped *TextChannelPolicyProofCache, deliver func(RotationTask) error) error {
	return s.dispatchRotationTask(ctx, resolve, channel, purpose, scoped, false, "", false, deliver)
}

func (s *Store) DispatchRecoveryRotationTask(ctx context.Context, resolve ResolveSession, channel, purpose string,
	scoped *TextChannelPolicyProofCache, deliver func(RotationTask) error) error {
	return s.dispatchRotationTask(ctx, resolve, channel, purpose, scoped, true, "", false, deliver)
}

// DispatchTransitionRotationTask reserves a lease only when the task has
// scoped transition evidence that a client without the current attestation can use.
func (s *Store) DispatchTransitionRotationTask(ctx context.Context, resolve ResolveSession, channel, purpose string,
	scoped *TextChannelPolicyProofCache, useRecovery bool, deliver func(RotationTask) error) error {
	if scoped == nil {
		return InvalidAction
	}
	return s.dispatchRotationTask(ctx, resolve, channel, purpose, scoped, useRecovery, "", true, deliver)
}

// DispatchRotationTaskContinuation reads an exact existing lease. It never
// reacquires an expired lease while continuing an earlier wire representation.
func (s *Store) DispatchRotationTaskContinuation(ctx context.Context, resolve ResolveSession, channel, purpose string,
	scoped *TextChannelPolicyProofCache, useRecovery bool, lease string, deliver func(RotationTask) error) error {
	if scoped == nil || !validRotationID(lease) {
		return InvalidAction
	}
	return s.dispatchRotationTask(ctx, resolve, channel, purpose, scoped, useRecovery, lease, false, deliver)
}

func (s *Store) dispatchRotationTask(ctx context.Context, resolve ResolveSession, channel, purpose string,
	scoped *TextChannelPolicyProofCache, useRecovery bool, expectedLease string, requireTransition bool, deliver func(RotationTask) error) error {
	var transition *TextChannelPolicyProofCache
	if requireTransition {
		transition = scoped
	}
	task, err := s.claimRotation(ctx, resolve, channel, purpose, useRecovery, expectedLease, transition)
	if err != nil {
		return err
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canLoadEpoch(actor, channel, purpose) {
			return ChannelRestricted
		}
		if task.Generation != state.currentGeneration(channel, purpose)+1 {
			return ErrRotationUnavailable
		}
		digest, err := state.PolicyDigest()
		if err != nil {
			return err
		}
		if digest != task.PolicyDigest {
			return ErrPolicyConflict
		}
		through, err := verifyRotationLease(ctx, conn, actor, task.EpochRecord, s.now().UnixMilli())
		if err != nil {
			return err
		}
		if through != task.ArchiveThrough {
			return ErrEpochConflict
		}
		if scoped != nil && !requireTransition {
			if err := populateScopedRotation(ctx, conn, state, actor, &task, scoped); err != nil {
				return err
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if scoped != nil && task.LeaseUntil <= s.now().UnixMilli() {
			return ErrRotationLease
		}
		return deliver(task)
	})
}

func populateScopedRotation(ctx context.Context, conn ScopeAuthorityQuery, state State, actor Principal, task *RotationTask, scoped *TextChannelPolicyProofCache) error {
	channel, purpose := task.ChannelID, task.Purpose
	head, err := readPolicyHead(ctx, conn)
	if err != nil {
		return err
	}
	if head.Draft.Revision != task.Revision || head.Draft.ResultDigest != task.PolicyDigest {
		return ErrPolicyConflict
	}
	if head.Draft.TextProjectionVersion < TextRotationAudienceVersion {
		return ErrPolicyAttestationUnavailable
	}
	task.TextPolicy, err = textChannelDisclosure(state, head, channel, actor.DeviceID, &scoped.current, 0)
	if err != nil {
		return err
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed)); err != nil {
		return ErrPolicyConflict
	}
	task.RecipientSalt = textRotationSalt(seed, channel, purpose)
	if purpose == LiveEpoch && head.Draft.TextProjectionVersion >= TextGroupedRotationProjectionVersion {
		task.RotationProfileOpenings = rotationProfileOpenings(task.Recipients, seed, channel, purpose)
		task.LivePersonalDeny, err = livePersonalDenyEvidence(ctx, conn, state, head, *task, actor, &scoped.history)
		if err != nil {
			return err
		}
	}
	if purpose == ArchiveEpoch && head.Draft.TextProjectionVersion >= TextGroupedArchiveRotationProjectionVersion {
		task.RotationProfileOpenings = rotationProfileOpenings(task.Recipients, seed, channel, purpose)
		task.ArchivePersonalDeny, err = personalDenyRotationEvidence(ctx, conn, state, head, *task, actor, &scoped.history)
		if err != nil {
			return err
		}
	}
	if head.Draft.TextProjectionVersion >= TextRoleViewDenyProjectionVersion {
		task.RoleViewDeny, err = roleViewDenyRotationEvidence(ctx, conn, state, head, *task, actor, &scoped.history)
		if err != nil {
			return err
		}
	}
	if head.Draft.TextProjectionVersion == ProfileRoleAuthorityProjectionVersion {
		task.RoleAssignment, err = scopedRoleAssignmentRotationEvidence(ctx, conn, state, head, *task, actor, &scoped.history)
		if err != nil {
			return err
		}
	}
	if head.Draft.Action == RedeemPolicyInvite && supportsScopedInviteReceipts(head.Draft.TextProjectionVersion) {
		task.InviteAdmission, err = inviteAdmissionRotationEvidence(ctx, conn, state, head, *task, actor, &scoped.history, nil)
		if err != nil {
			return err
		}
		if task.InviteAdmission == nil {
			task.InviteAdmissions, err = readCurrentInviteAdmissionBatch(ctx, conn, state, head, *task, actor, &scoped.history, nil)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func checkRotationTransitionAttestations(ctx context.Context, query SessionQuery, task RotationTask) error {
	required := []int64{task.Revision - 1}
	switch {
	case task.InviteAdmission != nil:
		if task.InviteAdmission.Draft == nil || task.InviteAdmission.Draft.Admission.Issuance == nil {
			return ErrPolicyAttestationUnavailable
		}
		required = []int64{task.InviteAdmission.PreviousRevision, task.InviteAdmission.Draft.Admission.Issuance.PolicyRevision}
	case task.InviteAdmissions != nil:
		required = []int64{task.InviteAdmissions.PreviousRevision}
		for _, entry := range task.InviteAdmissions.Admissions {
			if entry.Draft == nil || entry.Draft.Admission.Issuance == nil {
				return ErrPolicyAttestationUnavailable
			}
			required = append(required, entry.Draft.Admission.Issuance.PolicyRevision)
		}
	case task.RoleAssignment != nil, task.RoleViewDeny != nil, task.LivePersonalDeny != nil, task.ArchivePersonalDeny != nil:
	default:
		return ErrPolicyAttestationUnavailable
	}
	seen := make(map[int64]bool, len(required))
	for _, revision := range required {
		if seen[revision] {
			continue
		}
		seen[revision] = true
		var available bool
		if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_policy_attestations WHERE revision=?
			UNION ALL SELECT 1 FROM protected_policy_attestations_v2 WHERE revision=?)`, revision, revision).Scan(&available); err != nil {
			return err
		}
		if !available {
			return ErrPolicyAttestationUnavailable
		}
	}
	return nil
}

func rotationProfileOpenings(recipients map[string]KeyRecipient, seed [32]byte, channel, purpose string) map[string]RotationProfileOpening {
	openings := make(map[string]RotationProfileOpening)
	for _, recipient := range recipients {
		profile := recipient.ProfileID
		if _, exists := openings[profile]; !exists {
			openings[profile] = textRotationProfileOpening(seed, channel, purpose, profile)
		}
	}
	return openings
}

func (s *Store) DispatchPendingRotations(ctx context.Context, resolve ResolveSession, deliver func([]PendingRotation) error) error {
	return s.dispatchPendingRotations(ctx, resolve, false, deliver)
}

func (s *Store) DispatchPendingRecoveryRotations(ctx context.Context, resolve ResolveSession, deliver func([]PendingRotation) error) error {
	return s.dispatchPendingRotations(ctx, resolve, true, deliver)
}

func (s *Store) dispatchPendingRotations(ctx context.Context, resolve ResolveSession, useRecovery bool, deliver func([]PendingRotation) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		now := s.now().UnixMilli()
		rows, err := conn.QueryContext(ctx, `SELECT t.channel_id,t.purpose,
		    CASE WHEN t.lease_until>? THEN t.archive_through ELSE 0 END FROM protected_rotation_tasks t
		    WHERE (t.lease_until>? AND t.lease_device=?) OR (t.lease_until<=? AND (t.priority_until<=? OR t.initiator=?))
		    ORDER BY t.purpose DESC,t.channel_id`, now, now, actor.DeviceID, now, now, actor.ProfileID)
		if err != nil {
			return err
		}
		defer rows.Close()
		result := make([]PendingRotation, 0, 4)
		for len(result) < cap(result) && rows.Next() {
			var task PendingRotation
			var through uint64
			if err := rows.Scan(&task.ChannelID, &task.Purpose, &through); err != nil {
				return err
			}
			if !state.canLoadEpoch(actor, task.ChannelID, task.Purpose) {
				continue
			}
			if task.Purpose == ArchiveEpoch {
				live := state.currentGeneration(task.ChannelID, LiveEpoch)
				if live == 0 {
					continue
				}
				previous := state.currentGeneration(task.ChannelID, ArchiveEpoch)
				covered, err := previousArchiveCoverage(ctx, conn, task.ChannelID, previous+1)
				if err != nil {
					return err
				}
				if through == 0 {
					through = min(live, covered+archiveBatchSize)
				}
				if through < covered || through > live {
					return ErrEpochConflict
				}
				ready, err := hasArchiveRotationSources(ctx, conn, state, actor, task.ChannelID, previous, covered, through, now, useRecovery)
				if err != nil {
					return err
				}
				if !ready {
					continue
				}
			}
			result = append(result, task)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(result)
	})
}

func verifyRotationLease(ctx context.Context, tx SessionQuery, principal Principal, record EpochRecord, now int64) (uint64, error) {
	var lease string
	var covered uint64
	err := tx.QueryRowContext(ctx, `SELECT lease_id,archive_through FROM protected_rotation_tasks
	    WHERE task_id=? AND channel_id=? AND purpose=? AND revision=? AND lease_device=? AND lease_until>?`,
		record.TaskID, record.ChannelID, record.Purpose, record.Revision, principal.DeviceID, now).Scan(&lease, &covered)
	if errors.Is(err, sql.ErrNoRows) || err == nil && lease != record.LeaseID {
		return 0, ErrRotationLease
	}
	return covered, err
}
