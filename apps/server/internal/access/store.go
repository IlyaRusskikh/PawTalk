package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

var ErrPolicyConflict = errors.New("protected policy revision conflict")

// Store uses the existing SQLite transaction model. Its schema is installed
// explicitly by the protected-protocol initializer, outside API 2 startup.
type Store struct {
	db               *sql.DB
	now              func() time.Time
	storageOverLimit func(context.Context, *sql.Tx) (bool, error)
}

func NewStore(db *sql.DB) *Store { return NewStoreWithClock(db, time.Now) }

func NewStoreWithClock(db *sql.DB, now func() time.Time) *Store {
	return &Store{db: db, now: now}
}

func (s *Store) Initialize(ctx context.Context, initial State) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.InitializeInTransaction(ctx, tx, initial); err != nil {
		return err
	}
	return tx.Commit()
}

// InitializeInTransaction installs the initial policy and tasks without
// committing, so migration can include them in its own storage transaction.
func (s *Store) InitializeInTransaction(ctx context.Context, tx *sql.Tx, initial State) error {
	initial, err := normalizeInitialState(initial)
	if err != nil {
		return err
	}
	return s.installInitialState(ctx, tx, initial)
}

func normalizeInitialState(initial State) (State, error) {
	if !initial.validState() {
		return State{}, InvalidPolicy
	}
	for _, recipient := range initial.KeyRecipients {
		if !validRecipientKey(recipient.PublicKey) {
			return State{}, ErrRecipientKey
		}
	}
	// Trust only admission positions derived from the approved initial state.
	initial.Admissions = nil
	initial.EpochWindows = nil
	initial.ArchiveHeads = nil
	initial.refreshAdmissions()
	return initial, nil
}

func (s *Store) installInitialState(ctx context.Context, tx *sql.Tx, initial State) error {
	if _, err := tx.ExecContext(ctx, NicknameSchema); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_policy (
		id INTEGER PRIMARY KEY CHECK(id=1),
		revision INTEGER NOT NULL CHECK(revision>0),
		snapshot BLOB NOT NULL
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_policy_proofs (
		revision INTEGER PRIMARY KEY CHECK(revision>0),
		operation_id TEXT NOT NULL UNIQUE,
		digest TEXT NOT NULL,
		snapshot BLOB NOT NULL,
		record BLOB NOT NULL
	) STRICT`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_epochs (
		channel_id TEXT NOT NULL,
		purpose TEXT NOT NULL CHECK(purpose IN ('live','archive')),
		generation INTEGER NOT NULL CHECK(generation>0),
		key_id TEXT NOT NULL UNIQUE,
		task_id TEXT NOT NULL UNIQUE,
		digest TEXT NOT NULL,
		record BLOB NOT NULL,
		PRIMARY KEY(channel_id,purpose,generation)
	) STRICT`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_rotation_tasks (
		channel_id TEXT NOT NULL,
		purpose TEXT NOT NULL CHECK(purpose IN ('live','archive')),
		task_id TEXT NOT NULL UNIQUE,
		revision INTEGER NOT NULL,
		initiator TEXT NOT NULL,
		priority_until INTEGER NOT NULL,
		lease_device TEXT NOT NULL DEFAULT '',
		lease_id TEXT NOT NULL DEFAULT '',
		lease_until INTEGER NOT NULL DEFAULT 0,
		archive_through INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY(channel_id,purpose)
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_epoch_packages (
		channel_id TEXT NOT NULL,
		generation INTEGER NOT NULL,
		recipient_id TEXT NOT NULL,
		recipient_key TEXT NOT NULL,
		purpose TEXT NOT NULL,
		ciphertext BLOB NOT NULL,
		PRIMARY KEY(channel_id,purpose,generation,recipient_id),
		FOREIGN KEY(channel_id,purpose,generation) REFERENCES protected_epochs(channel_id,purpose,generation)
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_archive_links (
		channel_id TEXT NOT NULL,
		archive_generation INTEGER NOT NULL,
		purpose TEXT NOT NULL CHECK(purpose IN ('live','archive')),
		target_generation INTEGER NOT NULL,
		target_key_id TEXT NOT NULL,
		ciphertext BLOB NOT NULL CHECK(length(ciphertext)=60),
		PRIMARY KEY(channel_id,archive_generation,purpose,target_generation)
	) STRICT`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_messages (
		channel_id TEXT NOT NULL,
		position INTEGER NOT NULL CHECK(position>0),
		device_id TEXT NOT NULL,
		profile_id TEXT NOT NULL,
		operation_id TEXT NOT NULL,
		key_id TEXT NOT NULL,
		nonce BLOB NOT NULL CHECK(length(nonce)=12),
		ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 17 AND 12304),
		signature BLOB NOT NULL CHECK(length(signature)=64),
		PRIMARY KEY(channel_id,position)
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_message_receipts (
		channel_id TEXT NOT NULL,
		position INTEGER NOT NULL CHECK(position>0),
		device_id TEXT NOT NULL,
		profile_id TEXT NOT NULL,
		operation_id TEXT NOT NULL,
		key_id TEXT NOT NULL,
		sent_at INTEGER NOT NULL,
		nonce BLOB NOT NULL CHECK(length(nonce)=12),
		PRIMARY KEY(device_id,operation_id),
		UNIQUE(key_id,nonce)
	) STRICT;
	CREATE INDEX IF NOT EXISTS protected_send_rate ON protected_message_receipts(device_id,sent_at);
	CREATE INDEX IF NOT EXISTS protected_slowmode ON protected_message_receipts(channel_id,profile_id,sent_at);
	CREATE TABLE IF NOT EXISTS protected_voice_slots (
		channel_id TEXT NOT NULL,
		profile_id TEXT NOT NULL,
		session_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		active_until INTEGER NOT NULL,
		grant_until INTEGER NOT NULL,
		grant_digest TEXT NOT NULL DEFAULT '',
		grant_capacity INTEGER NOT NULL DEFAULT 0 CHECK(grant_capacity>=0),
		can_speak INTEGER NOT NULL CHECK(can_speak IN (0,1)),
		can_receive INTEGER NOT NULL CHECK(can_receive IN (0,1)),
		reconcile_pending INTEGER NOT NULL DEFAULT 0 CHECK(reconcile_pending IN (0,1)),
		disconnect_pending INTEGER NOT NULL DEFAULT 0 CHECK(disconnect_pending IN (0,1)),
		PRIMARY KEY(channel_id,profile_id)
	) STRICT;
	CREATE INDEX IF NOT EXISTS protected_voice_profile ON protected_voice_slots(profile_id,active_until);
	CREATE TABLE IF NOT EXISTS protected_voice_moves (
		profile_id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		source TEXT NOT NULL,
		destination TEXT NOT NULL,
		moderator_profile TEXT NOT NULL,
		moderator_device TEXT NOT NULL,
		expires_at INTEGER NOT NULL,
		ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1))
	) STRICT;
	CREATE INDEX IF NOT EXISTS protected_voice_move_destination ON protected_voice_moves(destination,expires_at)`); err != nil {
		return err
	}
	if err := EnsureAttachmentSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureMessageDeletionSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureMessagePinSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureMessageReplySchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureMentionSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureInviteSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureChecklistSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsurePollVotingSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureTimeoutSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureAuditSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureCommunityNameSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureCommunityAvatarSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureRevisionSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsurePolicyAttestationSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureOwnerTransferSchema(ctx, tx); err != nil {
		return err
	}
	if err := EnsureChannelLayoutSchema(ctx, tx); err != nil {
		return err
	}
	encoded, err := json.Marshal(initial)
	if err != nil {
		return err
	}
	inserted, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO protected_policy(id,revision,snapshot) VALUES(1,1,?)", encoded)
	if err != nil {
		return err
	}
	count, err := inserted.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrPolicyConflict
	}
	return syncRotationTasks(ctx, tx, initial, nil, nil, 1, initial.Owner, s.now().UnixMilli())
}

func readState(row *sql.Row) (State, int64, error) {
	var state State
	var revision int64
	var snapshot []byte
	if err := row.Scan(&revision, &snapshot); err != nil {
		return state, 0, err
	}
	if err := json.Unmarshal(snapshot, &state); err != nil {
		return state, 0, err
	}
	return state, revision, nil
}

// Snapshot is for trusted server callers. Client-facing reads must project it.
func (s *Store) Snapshot(ctx context.Context) (State, int64, error) {
	return readState(s.db.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
}

func (s *Store) change(ctx context.Context, revision int64, actor string, apply func(*State) error) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	state, current, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return 0, err
	}
	if current != revision {
		return 0, ErrPolicyConflict
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return 0, err
	}
	if state.PolicyAnchored || head.Digest != "" {
		return 0, ErrPolicySignatureRequired
	}
	recipients := state.recipients()
	if err = apply(&state); err != nil {
		return 0, err
	}
	if err := s.persistChange(ctx, tx, state, current, actor, recipients, nil); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return current + 1, nil
}

func (s *Store) persistChange(ctx context.Context, tx *sql.Tx, state State, current int64, actor string,
	recipients map[string]map[string]bool, keyChanges map[string]bool) error {
	if !state.validState() {
		return InvalidPolicy
	}
	state.refreshAdmissions()
	now := s.now().UnixMilli()
	state.updateEpochWindows(recipients, now)
	if err := state.invalidateVoiceGrants(ctx, tx, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_voice_slots SET reconcile_pending=1 WHERE active_until>?", now); err != nil {
		return err
	}
	if err := syncRotationTasks(ctx, tx, state, recipients, keyChanges, current+1, actor, now); err != nil {
		return err
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, "UPDATE protected_policy SET revision=revision+1,snapshot=? WHERE id=1 AND revision=?", encoded, current)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return ErrPolicyConflict
	}
	return nil
}

func (d Decision) Error() string { return string(d) }

type RoleChangeFailure struct{ RoleChangeResult }

func (f RoleChangeFailure) Error() string { return string(f.Decision) }

func (f RoleChangeFailure) Unwrap() error { return f.Decision }
