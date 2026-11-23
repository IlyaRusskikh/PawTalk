package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"slices"
)

type PollResult struct {
	Original     uint64 `json:"originalPosition"`
	SourceDigest string `json:"originalDigest"`
	ClosedAt     int64  `json:"closedAt"`
	Total        int    `json:"total"`
	Counts       []int  `json:"counts"`
	Signature    string `json:"signature"`
}

type SignPollResult func(context.Context, SessionQuery, string, uint64, PollResult) (string, error)

type frozenPollResult struct {
	channel string
	PollResult
	publicationDigest string
}

type pollResultRows interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *Store) PublishPollResults(ctx context.Context, hasImported bool, sign SignPollResult) error {
	return s.publishPollResults(ctx, "", 0, hasImported, sign)
}

func (s *Store) PublishPollResult(ctx context.Context, channel string, position uint64, hasImported bool, sign SignPollResult) error {
	return s.publishPollResults(ctx, channel, position, hasImported, sign)
}

func (s *Store) publishPollResults(ctx context.Context, channel string, position uint64, hasImported bool, sign SignPollResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var args []any
	filter := ` WHERE EXISTS (SELECT 1 FROM protected_policy policy, json_each(policy.snapshot,'$.Channels') ch
		WHERE policy.id=1 AND ch.key=pending.channel_id)`
	if position != 0 {
		filter += " AND pending.channel_id=? AND pending.position=?"
		args = append(args, channel, position)
	}
	batch, err := readPendingPollResults(ctx, tx, hasImported, filter, args, 8)
	if err != nil || len(batch) == 0 {
		return err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	return s.commitFrozenPollResults(ctx, tx, state, batch, sign)
}

func readPendingPollResults(ctx context.Context, queryer pollResultRows, hasImported bool, filter string, args []any, limit int) ([]frozenPollResult, error) {
	query := `SELECT f.channel_id,f.position,f.closed_at,f.total,f.counts,m.signature
		FROM protected_poll_closures f JOIN protected_messages m ON m.channel_id=f.channel_id AND m.position=f.position
		JOIN protected_polls p ON p.channel_id=f.channel_id AND p.position=f.position
		WHERE NOT EXISTS (SELECT 1 FROM protected_poll_results r WHERE r.channel_id=f.channel_id AND r.original_position=f.position)
		AND NOT EXISTS (SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=f.channel_id AND d.position=f.position)`
	if hasImported {
		query += ` UNION ALL SELECT f.channel_id,f.position,f.closed_at,f.total,f.counts,m.signature
			FROM protected_poll_closures f
			JOIN protected_migration_message_positions i ON i.channel_id=f.channel_id AND i.position=f.position
			JOIN polls p ON p.message_id=i.message_id AND p.result_message_id IS NULL
			JOIN protected_migration_records m ON m.kind='messages' AND m.source_id=CAST(i.message_id AS TEXT) AND m.channel_id=i.channel_id
			WHERE NOT EXISTS (SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=f.channel_id AND d.position=f.position)
			AND NOT EXISTS (SELECT 1 FROM protected_poll_results r WHERE r.channel_id=f.channel_id AND r.original_position=f.position)`
	}
	rows, err := queryer.QueryContext(ctx, `SELECT pending.* FROM (`+query+`) pending`+filter+" ORDER BY 3,1,2 LIMIT ?", append(args, limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var batch []frozenPollResult
	for rows.Next() {
		var item frozenPollResult
		var counts string
		var source []byte
		if err := rows.Scan(&item.channel, &item.Original, &item.ClosedAt, &item.Total, &counts, &source); err != nil {
			return nil, err
		}
		if len(source) != 64 || item.ClosedAt <= 0 || item.Total < 0 || json.Unmarshal([]byte(counts), &item.Counts) != nil ||
			len(item.Counts) < 2 || len(item.Counts) > 10 || slices.ContainsFunc(item.Counts, func(count int) bool { return count < 0 || count > item.Total }) {
			return nil, InvalidPolicy
		}
		item.SourceDigest = hexHash(source)
		batch = append(batch, item)
	}
	return batch, rows.Err()
}

func (s *Store) commitFrozenPollResults(ctx context.Context, tx *sql.Tx, state State, batch []frozenPollResult, sign SignPollResult) error {
	if !state.PolicyAnchored {
		return ErrPolicySignatureRequired
	}
	var protected []storagePosition
	var err error
	for _, item := range batch {
		channel, ok := state.Channels[item.channel]
		if !ok {
			continue
		}
		position := channel.NextPosition
		if sign == nil || position <= item.Original || position >= math.MaxInt64 {
			return InvalidPolicy
		}
		item.Signature, err = sign(ctx, tx, item.channel, position, item.PollResult)
		if err != nil {
			return err
		}
		payload, err := json.Marshal(struct {
			PollResult
			PublicationDigest string `json:"publicationDigest,omitempty"`
		}{PollResult: item.PollResult, PublicationDigest: item.publicationDigest})
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_poll_results(channel_id,position,original_position,record)
			VALUES(?,?,?,?)`, item.channel, position, item.Original, string(payload)); err != nil {
			return err
		}
		protected = append(protected, storagePosition{item.channel, item.Original}, storagePosition{item.channel, position})
		channel.NextPosition++
		state.Channels[item.channel] = channel
	}
	snapshot, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_policy SET snapshot=? WHERE id=1", snapshot); err != nil {
		return err
	}
	if err := s.enforceStorageRetention(ctx, tx, protected...); err != nil {
		return err
	}
	return tx.Commit()
}

func readPublishedPollResults(ctx context.Context, conn *sql.Conn, channel string, first, start, next uint64, limit int) ([]LiveMessage, error) {
	rows, err := conn.QueryContext(ctx, `SELECT r.position,r.record FROM protected_poll_results r
		WHERE r.channel_id=? AND r.position>=? AND r.position<? AND r.original_position>=?
		AND NOT EXISTS (SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=r.channel_id
			AND d.position IN (r.position,r.original_position))
		ORDER BY r.position LIMIT ?`, channel, start, next, first, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var messages []LiveMessage
	for rows.Next() {
		var message LiveMessage
		var raw string
		if err := rows.Scan(&message.Position, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &message.PollResult); err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}
