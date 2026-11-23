package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"strconv"
)

func freezePoll(ctx context.Context, tx *sql.Tx, channel string, position uint64, poll PollDefinition, closed int64) error {
	poll.ClosedAt = &closed
	poll.Anonymous = true
	tally, err := readPollState(ctx, tx, channel, position, "", poll, MissingGrant, nil)
	if err != nil {
		return err
	}
	counts, err := json.Marshal(tally.Counts)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_poll_closures(channel_id,position,closed_at,counts,total)
		VALUES(?,?,?,?,?)`, channel, position, closed, string(counts), tally.Total)
	return err
}

func (s *Store) ClosePoll(ctx context.Context, resolve ResolveSession, lookup ResolvePoll, channel string, position uint64) error {
	if position == 0 || position >= math.MaxInt64 {
		return InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	poll, grants, err := s.pollAccess(ctx, tx, state, actor, lookup, channel, position)
	if err != nil {
		return err
	}
	if grants.Close != Allowed {
		return grants.Close
	}
	if poll.ClosedAt != nil {
		return nil
	}
	now := s.now().UnixMilli()
	if err = freezePoll(ctx, tx, channel, position, poll, min(now, poll.ClosesAt)); err != nil {
		return err
	}
	if now < poll.ClosesAt {
		if err = recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: "poll.close",
			Kind: "poll", ObjectID: strconv.FormatUint(position, 10), ChannelID: channel, Position: position}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) FreezeExpiredPolls(ctx context.Context, imported ResolvePoll) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	query := `SELECT p.channel_id,p.position,p.closes_at FROM protected_polls p
		JOIN protected_messages m ON m.channel_id=p.channel_id AND m.position=p.position
		WHERE p.closed_at IS NULL AND p.closes_at<=?
		AND NOT EXISTS(SELECT 1 FROM protected_poll_closures c WHERE c.channel_id=p.channel_id AND c.position=p.position)`
	args := []any{now}
	if imported != nil {
		query += ` UNION ALL SELECT i.channel_id,i.position,p.closes_at FROM polls p
			JOIN protected_migration_message_positions i ON i.message_id=p.message_id
			JOIN protected_migration_records r ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
			WHERE p.closed_at IS NULL AND p.closes_at<=?
			AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=i.channel_id AND d.position=i.position)
			AND NOT EXISTS(SELECT 1 FROM protected_poll_closures c WHERE c.channel_id=i.channel_id AND c.position=i.position)`
		args = append(args, now)
	}
	rows, err := tx.QueryContext(ctx, query+" ORDER BY 3,1,2 LIMIT 8", args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	type duePoll struct {
		channel  string
		position uint64
		deadline int64
	}
	var due []duePoll
	for rows.Next() {
		var next duePoll
		if err := rows.Scan(&next.channel, &next.position, &next.deadline); err != nil {
			return err
		}
		due = append(due, next)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, next := range due {
		poll, err := resolveMessagePoll(ctx, tx, imported, next.channel, next.position)
		if err != nil {
			return err
		}
		if poll.OptionCount < 2 || poll.OptionCount > 10 {
			return InvalidPolicy
		}
		if err = freezePoll(ctx, tx, next.channel, next.position, poll, next.deadline); err != nil {
			return err
		}
	}
	return tx.Commit()
}
