package access

import (
	"cmp"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"slices"
)

const moderationCleanupSchema = `;
CREATE TABLE IF NOT EXISTS protected_cleanup_previews (
	id TEXT PRIMARY KEY, device_id TEXT NOT NULL, profile_id TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL,
	revision INTEGER NOT NULL, since INTEGER NOT NULL, through INTEGER NOT NULL, expires_at INTEGER NOT NULL,
	digest TEXT NOT NULL, message_count INTEGER NOT NULL, operation_id TEXT UNIQUE
) STRICT;
CREATE INDEX IF NOT EXISTS protected_cleanup_expiry ON protected_cleanup_previews(expires_at);`

var ErrCleanupChanged = errors.New("protected moderation cleanup changed")

const cleanupBatchSize = 128
const cleanupPreviewLifetime = 120_000

type ModerationCleanupSources struct {
	ImportedPositions func(context.Context, *sql.Tx, string, string, uint64, int64, int64, int) ([]uint64, error)
	ImportedMessage   ResolveImportedMessage
	ImportedPoll      ResolveCompletedPoll
}

type ModerationCleanupPreview struct {
	ID    string `json:"id"`
	Count int64  `json:"count"`
}

func (s *Store) PreviewModerationCleanup(ctx context.Context, resolve ResolveSession, sources ModerationCleanupSources,
	target, action, window string) (ModerationCleanupPreview, error) {
	var result ModerationCleanupPreview
	spans := map[string]int64{"hour": 3_600_000, "day": 86_400_000, "week": 604_800_000, "all": 0}
	span, valid := spans[window]
	if !valid || !isDigest(target) || (action != KickPolicyMember && action != BanPolicyMember) {
		return result, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return result, err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return result, err
	}
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) {
		return result, Inactive
	}
	now := s.now().UnixMilli()
	if grant := state.CheckAction(state.Members[actor.ProfileID], state.Members[target], Scope{}, action, false, now); grant != Allowed {
		return result, grant
	}
	since := int64(0)
	if span != 0 {
		since = max(0, now-span)
	}
	digest, count, err := walkModerationCleanup(ctx, tx, state, sources, actor, target, since, now, now, false)
	if err != nil {
		return result, err
	}
	id, err := randomRotationID()
	if err != nil {
		return result, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_cleanup_previews WHERE expires_at<=? OR (device_id=? AND operation_id IS NULL)",
		now, actor.DeviceID); err != nil {
		return result, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_cleanup_previews
		(id,device_id,profile_id,target,action,revision,since,through,expires_at,digest,message_count)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, actor.DeviceID, actor.ProfileID, target, action, revision, since, now, now+cleanupPreviewLifetime, digest, count); err != nil {
		return result, err
	}
	return ModerationCleanupPreview{ID: id, Count: count}, tx.Commit()
}

func (s *Store) ApplyModerationCleanup(ctx context.Context, resolve ResolveSession, sources ModerationCleanupSources,
	id, operationID string) (int64, error) {
	if !validRotationID(id) || !validRotationID(operationID) {
		return 0, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return 0, err
	}
	var target, action, expectedDigest string
	var revision, since, through, expires, expectedCount int64
	var completed sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT target,action,revision,since,through,expires_at,digest,message_count,operation_id
		FROM protected_cleanup_previews WHERE id=? AND device_id=? AND profile_id=?`, id, actor.DeviceID, actor.ProfileID).
		Scan(&target, &action, &revision, &since, &through, &expires, &expectedDigest, &expectedCount, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrCleanupChanged
	}
	if err != nil {
		return 0, err
	}
	if completed.Valid {
		if completed.String != operationID {
			return 0, ErrCleanupChanged
		}
		return expectedCount, nil
	}
	now := s.now().UnixMilli()
	if now >= expires {
		return 0, ErrCleanupChanged
	}
	proof, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx,
		"SELECT revision,operation_id,digest,record FROM protected_policy_proofs WHERE operation_id=?", operationID))
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrCleanupChanged
	}
	if err != nil {
		return 0, err
	}
	if proof.Principal != actor || proof.Draft.Action != action || proof.Draft.Revision <= revision ||
		proof.Draft.ResourceChange == nil || proof.Draft.ResourceChange.ID != target {
		return 0, ErrCleanupChanged
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return 0, err
	}
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) ||
		state.CheckGrant(state.Members[actor.ProfileID], Scope{}, action, now) != Allowed {
		return 0, MissingGrant
	}
	// Mark the receipt in the same transaction as deletion. A preview or
	// moderation operation cannot authorize a second cleanup.
	written, err := tx.ExecContext(ctx, "UPDATE OR IGNORE protected_cleanup_previews SET operation_id=? WHERE id=? AND operation_id IS NULL", operationID, id)
	if err != nil {
		return 0, err
	}
	if count, err := written.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return 0, err
		}
		return 0, ErrCleanupChanged
	}
	digest, count, err := walkModerationCleanup(ctx, tx, state, sources, actor, target, since, through, now, true)
	if err != nil {
		return 0, err
	}
	if digest != expectedDigest || count != expectedCount {
		return 0, ErrCleanupChanged
	}
	return count, tx.Commit()
}

type cleanupCandidate struct {
	position uint64
	imported bool
}

func walkModerationCleanup(ctx context.Context, tx *sql.Tx, state State, sources ModerationCleanupSources, actor Principal,
	target string, since, through, now int64, remove bool) (string, int64, error) {
	digest := sha256.New()
	var count int64
	subject := state.Members[actor.ProfileID]
	for _, id := range slices.Sorted(maps.Keys(state.Channels)) {
		channel := state.Channels[id]
		if channel.Kind != "text" || !state.CanDeliver(actor.ProfileID, id, 0) || !state.canUseDevice(actor) {
			continue
		}
		scope := state.scope(channel)
		deleteOther := state.CheckGrant(subject, scope, "message.delete-other", now) == Allowed
		deletePoll := state.CheckGrant(subject, scope, "poll.delete-completed", now) == Allowed
		if !deleteOther && !deletePoll {
			continue
		}
		next := state.firstReadablePosition(id, actor.ProfileID) - 1
		for {
			if err := ctx.Err(); err != nil {
				return "", 0, err
			}
			batch, err := readCleanupCandidates(ctx, tx, sources, id, target, next, since, through)
			if err != nil {
				return "", 0, err
			}
			if len(batch) == 0 {
				break
			}
			next = batch[len(batch)-1].position
			for _, candidate := range batch {
				position := candidate.position
				if !state.CanDeliver(actor.ProfileID, id, position) {
					continue
				}
				var importedPoll ResolveCompletedPoll
				if candidate.imported {
					importedPoll = sources.ImportedPoll
				}
				poll, err := loadCompletedPollMessages(ctx, tx, importedPoll, id, position, now)
				if err == nil {
					if !deletePoll || poll.Author != target || poll.Result != 0 &&
						(poll.Result <= position || !state.CanDeliver(actor.ProfileID, id, poll.Result)) {
						continue
					}
					fmt.Fprintf(digest, "%s/%d/poll/%d\n", id, position, poll.Result)
					count++
					if poll.Result != 0 {
						count++
					}
					if remove {
						if err := deleteAuditedPoll(ctx, tx, actor.ProfileID, id, position, poll, now); err != nil {
							return "", 0, err
						}
					}
					continue
				}
				if !errors.Is(err, sql.ErrNoRows) {
					return "", 0, err
				}
				if !deleteOther {
					continue
				}
				if candidate.imported {
					author, err := sources.ImportedMessage(ctx, tx, id, position, now)
					if errors.Is(err, ErrMessageKind) || errors.Is(err, sql.ErrNoRows) || err == nil && author != target {
						continue
					}
					if err != nil {
						return "", 0, err
					}
				}
				fmt.Fprintf(digest, "%s/%d/message\n", id, position)
				count++
				if remove {
					if err := deleteAuditedMessage(ctx, tx, actor.ProfileID, id, position, target, now); err != nil {
						return "", 0, err
					}
				}
			}
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), count, nil
}

func readCleanupCandidates(ctx context.Context, tx *sql.Tx, sources ModerationCleanupSources, channel, target string,
	after uint64, since, through int64) ([]cleanupCandidate, error) {
	rows, err := tx.QueryContext(ctx, `SELECT m.position FROM protected_messages m
		JOIN protected_message_receipts r ON r.device_id=m.device_id AND r.operation_id=m.operation_id
		WHERE m.channel_id=? AND m.profile_id=? AND m.position>? AND r.sent_at BETWEEN ? AND ?
		  AND NOT EXISTS(SELECT 1 FROM protected_poll_results p WHERE p.channel_id=m.channel_id AND p.position=m.position)
		ORDER BY m.position LIMIT ?`, channel, target, after, since, through, cleanupBatchSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make([]cleanupCandidate, 0, cleanupBatchSize)
	for rows.Next() {
		var position uint64
		if err := rows.Scan(&position); err != nil {
			return nil, err
		}
		candidates = append(candidates, cleanupCandidate{position: position})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if sources.ImportedPositions != nil {
		imported, err := sources.ImportedPositions(ctx, tx, channel, target, after, since, through, cleanupBatchSize)
		if err != nil {
			return nil, err
		}
		for _, position := range imported {
			candidates = append(candidates, cleanupCandidate{position: position, imported: true})
		}
		slices.SortFunc(candidates, func(a, b cleanupCandidate) int {
			return cmp.Compare(a.position, b.position)
		})
	}
	return candidates[:min(cleanupBatchSize, len(candidates))], nil
}
