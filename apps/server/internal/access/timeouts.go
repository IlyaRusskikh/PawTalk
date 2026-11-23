package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

const timeoutSchema = `
CREATE TABLE IF NOT EXISTS protected_timeouts (
	profile_id TEXT PRIMARY KEY,
	deadline INTEGER NOT NULL CHECK(deadline>=0),
	reason TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS protected_timeout_actions (
	device_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	actor_profile_id TEXT NOT NULL,
	target_profile_id TEXT NOT NULL,
	duration_seconds INTEGER NOT NULL,
	reason TEXT NOT NULL,
	previous_deadline INTEGER NOT NULL,
	deadline INTEGER NOT NULL,
	applied_at INTEGER NOT NULL,
	PRIMARY KEY(device_id,operation_id)
) STRICT;`

func EnsureTimeoutSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, timeoutSchema)
	return err
}

type TimeoutRequest struct {
	OperationID     string `json:"operationId"`
	DurationSeconds int64  `json:"durationSeconds"`
	Reason          string `json:"reason"`
}

type TimeoutStatus struct {
	Deadline int64  `json:"deadline"`
	Reason   string `json:"reason,omitempty"`
	CanSet   bool   `json:"canSet"`
	CanLift  bool   `json:"canLift"`
}

type TimeoutReceipt struct {
	Deadline int64 `json:"deadline"`
	Existing bool  `json:"existing"`
}

func timeoutReasonFingerprint(reason string) string {
	sum := sha256.Sum256([]byte(reason))
	return "\x00" + hex.EncodeToString(sum[:])
}

func recordTimeoutAudit(ctx context.Context, tx *sql.Tx, actor, target, reason string, at, previous, deadline int64) error {
	action := "member.timeout"
	if deadline == 0 {
		action = "member.timeout.lift"
	}
	return recordAudit(ctx, tx, AuditEvent{At: at, Actor: actor, Action: action, Kind: "member", ObjectID: target, Reason: reason,
		Change: AuditChange{Previous: &previous, Current: &deadline}})
}

// Earlier timeout receipts included the reason in cleartext. Move it into
// the user-facing journal and keep only the fingerprint needed on retry.
func importTimeoutAudit(ctx context.Context, tx *sql.Tx) error {
	type previousTimeout struct {
		device, operation, actor, target, reason string
		at, previous, deadline                   int64
	}
	for {
		rows, err := tx.QueryContext(ctx, `SELECT device_id,operation_id,actor_profile_id,target_profile_id,reason,applied_at,previous_deadline,deadline
			FROM protected_timeout_actions WHERE substr(CAST(reason AS BLOB),1,1)<>x'00' LIMIT 256`)
		if err != nil {
			return err
		}
		var pending []previousTimeout
		for rows.Next() {
			var entry previousTimeout
			if err := rows.Scan(&entry.device, &entry.operation, &entry.actor, &entry.target, &entry.reason, &entry.at,
				&entry.previous, &entry.deadline); err != nil {
				rows.Close()
				return err
			}
			pending = append(pending, entry)
		}
		err = rows.Err()
		rows.Close()
		if err != nil || len(pending) == 0 {
			return err
		}
		for _, entry := range pending {
			if err := recordTimeoutAudit(ctx, tx, entry.actor, entry.target, entry.reason, entry.at, entry.previous, entry.deadline); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE protected_timeout_actions SET reason=? WHERE device_id=? AND operation_id=?",
				timeoutReasonFingerprint(entry.reason), entry.device, entry.operation); err != nil {
				return err
			}
		}
	}
}

// A timeout restricts operations using the signed grants. Its expiration is
// server time and does not change channel view, history, or key recipients.
func readTimeout(ctx context.Context, query SessionQuery, subject Subject) (TimeoutStatus, error) {
	result := TimeoutStatus{Deadline: subject.TimeoutUntil}
	err := query.QueryRowContext(ctx, "SELECT deadline,reason FROM protected_timeouts WHERE profile_id=?", subject.ID).
		Scan(&result.Deadline, &result.Reason)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return result, err
}

func timeoutAuthority(state State, actor Principal, target Subject, lifting bool, now int64) Decision {
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !target.Active {
		return Inactive
	}
	return state.CheckAction(state.Members[actor.ProfileID], target, Scope{}, "member.timeout", lifting, now)
}

func (s *Store) DispatchTimeout(ctx context.Context, resolve ResolveSession, profile string, deliver func(TimeoutStatus) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		target := state.Members[profile]
		now := s.now().UnixMilli()
		canLift := timeoutAuthority(state, actor, target, true, now) == Allowed
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !target.Active || (profile != actor.ProfileID && !canLift) {
			return ChannelRestricted
		}
		result, err := readTimeout(ctx, conn, target)
		if err != nil {
			return err
		}
		if result.Deadline <= now {
			result = TimeoutStatus{}
		}
		result.CanSet = timeoutAuthority(state, actor, target, false, now) == Allowed
		result.CanLift = canLift && result.Deadline > 0
		return deliver(result)
	})
}

var ErrTimeoutConflict = errors.New("protected timeout operation conflict")

func (s *Store) ChangeTimeout(ctx context.Context, resolve ResolveSession, targetID string, request TimeoutRequest,
	invalidateVoiceKeys func(context.Context, *sql.Tx, string) error) (TimeoutReceipt, error) {
	const maxTimeoutSeconds = 28 * 24 * 60 * 60
	reason := strings.TrimSpace(request.Reason)
	lift := request.DurationSeconds == 0
	if !isDigest(targetID) || !validRotationID(request.OperationID) ||
		(!lift && (request.DurationSeconds < 60 || request.DurationSeconds > maxTimeoutSeconds)) ||
		reason == "" || utf8.RuneCountInString(reason) > 200 || strings.ContainsFunc(reason, unicode.IsControl) {
		return TimeoutReceipt{}, InvalidAction
	}
	fingerprint := timeoutReasonFingerprint(reason)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return TimeoutReceipt{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return TimeoutReceipt{}, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return TimeoutReceipt{}, err
	}
	target := state.Members[targetID]
	now := s.now().UnixMilli()
	if decision := timeoutAuthority(state, actor, target, lift, now); decision != Allowed {
		return TimeoutReceipt{}, decision
	}
	var existing TimeoutReceipt
	var oldActor, oldTarget, oldReason string
	var oldDuration int64
	err = tx.QueryRowContext(ctx, `SELECT actor_profile_id,target_profile_id,duration_seconds,reason,deadline
		FROM protected_timeout_actions WHERE device_id=? AND operation_id=?`, actor.DeviceID, request.OperationID).
		Scan(&oldActor, &oldTarget, &oldDuration, &oldReason, &existing.Deadline)
	if err == nil {
		if oldActor != actor.ProfileID || oldTarget != targetID || oldDuration != request.DurationSeconds || oldReason != fingerprint {
			return TimeoutReceipt{}, ErrTimeoutConflict
		}
		existing.Existing = true
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return TimeoutReceipt{}, err
	}
	previous, err := readTimeout(ctx, tx, target)
	if err != nil {
		return TimeoutReceipt{}, err
	}
	var deadline int64
	if !lift {
		deadline = now + request.DurationSeconds*1000
		if invalidateVoiceKeys != nil {
			if err := invalidateVoiceKeys(ctx, tx, targetID); err != nil {
				return TimeoutReceipt{}, err
			}
		}
		// Even a timeout lifted before media reconciliation invalidates the old
		// grant. An explicit fresh join is required after disconnection.
		if _, err := tx.ExecContext(ctx, `UPDATE protected_voice_slots
			SET active_until=0,grant_digest='',reconcile_pending=0,disconnect_pending=(disconnect_pending=1 OR grant_until>0)
			WHERE profile_id=? AND active_until>0`, targetID); err != nil {
			return TimeoutReceipt{}, err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM protected_voice_moves WHERE profile_id=?", targetID); err != nil {
			return TimeoutReceipt{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_timeouts(profile_id,deadline,reason) VALUES(?,?,?)
		ON CONFLICT(profile_id) DO UPDATE SET deadline=excluded.deadline,reason=excluded.reason`, targetID, deadline, reason); err != nil {
		return TimeoutReceipt{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_timeout_actions
		(device_id,operation_id,actor_profile_id,target_profile_id,duration_seconds,reason,previous_deadline,deadline,applied_at)
		VALUES(?,?,?,?,?,?,?,?,?)`, actor.DeviceID, request.OperationID, actor.ProfileID, targetID,
		request.DurationSeconds, fingerprint, previous.Deadline, deadline, now); err != nil {
		return TimeoutReceipt{}, err
	}
	if err := recordTimeoutAudit(ctx, tx, actor.ProfileID, targetID, reason, now, previous.Deadline, deadline); err != nil {
		return TimeoutReceipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return TimeoutReceipt{}, err
	}
	return TimeoutReceipt{Deadline: deadline}, nil
}
