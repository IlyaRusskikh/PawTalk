package access

import (
	"context"
	"database/sql"
	"strconv"
)

const pinPageSize = 32

func EnsureMessagePinSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_message_pins (
		channel_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0),
		PRIMARY KEY(channel_id,position)
	) STRICT`)
	return err
}

type PinnedMessage struct {
	Position uint64 `json:"position"`
	Revision uint64 `json:"revision"`
}

type PinnedMessagesPage struct {
	Items  []PinnedMessage `json:"items"`
	Next   uint64          `json:"next,omitempty"`
	CanPin bool            `json:"canPin"`
}

func retainedMessageOriginal(hasImported bool) string {
	// Both stores share original positions. Tombstones also cover the
	// immutable imported rows and must win over either retained source.
	live := `EXISTS (SELECT 1 FROM protected_messages m WHERE m.channel_id=p.channel_id AND m.position=p.position)
		OR EXISTS (SELECT 1 FROM protected_poll_results r WHERE r.channel_id=p.channel_id AND r.position=p.position
			AND r.original_position>=? AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d
				WHERE d.channel_id=r.channel_id AND d.position=r.original_position))`
	if hasImported {
		live += ` OR EXISTS (SELECT 1 FROM protected_migration_message_positions i
			JOIN messages m ON m.message_id=i.message_id AND m.channel_id=i.channel_id
			JOIN protected_migration_records r ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
			WHERE i.channel_id=p.channel_id AND i.position=p.position AND ` + ImportedPollResultAllowed("?", true) + `)`
	}
	return `(` + live + `) AND NOT EXISTS (SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=p.channel_id AND d.position=p.position)`
}

func canReadRetainedMessage(ctx context.Context, query SessionQuery, channel string, position, first uint64, hasImported bool) (bool, error) {
	args := []any{first}
	if hasImported {
		args = append(args, first)
	}
	args = append(args, channel, position)
	var retained bool
	err := query.QueryRowContext(ctx, `SELECT `+retainedMessageOriginal(hasImported)+` FROM (SELECT ? AS channel_id,? AS position) p`,
		args...).Scan(&retained)
	return retained, err
}

func readPinnedMessages(ctx context.Context, conn *sql.Conn, channel string, hasImported, canPin bool,
	first, next, before uint64) (PinnedMessagesPage, error) {
	page := PinnedMessagesPage{Items: []PinnedMessage{}, CanPin: canPin}
	if before != 0 {
		next = min(next, before)
	}
	args := []any{channel, first, next, first}
	if hasImported {
		args = append(args, first)
	}
	rows, err := conn.QueryContext(ctx, `SELECT p.position,COALESCE(
		(SELECT MAX(r.revision) FROM protected_text_revisions r WHERE r.channel_id=p.channel_id AND r.position=p.position),1)
		FROM protected_message_pins p WHERE p.channel_id=? AND p.position>=? AND p.position<? AND `+retainedMessageOriginal(hasImported)+`
		ORDER BY p.position DESC LIMIT ?`, append(args, pinPageSize+1)...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		if len(page.Items) == pinPageSize {
			page.Next = page.Items[len(page.Items)-1].Position
			break
		}
		var item PinnedMessage
		if err := rows.Scan(&item.Position, &item.Revision); err != nil {
			return page, err
		}
		page.Items = append(page.Items, item)
	}
	return page, rows.Err()
}

func (s *Store) DispatchPinnedMessages(ctx context.Context, resolve ResolveSession, channel string, hasImported bool,
	before uint64, deliver func(PinnedMessagesPage) error) error {
	return s.dispatchHistory(ctx, resolve, channel, func(conn *sql.Conn, state State, actor Principal, first, next uint64) error {
		subject := state.Members[actor.ProfileID]
		timeout, err := readTimeout(ctx, conn, subject)
		if err != nil {
			return err
		}
		subject.TimeoutUntil = timeout.Deadline
		canPin := state.CheckGrant(subject, state.scope(state.Channels[channel]), "message.pin", s.now().UnixMilli()) == Allowed
		page, err := readPinnedMessages(ctx, conn, channel, hasImported, canPin, first, next, before)
		if err != nil {
			return err
		}
		return deliver(page)
	})
}

func (s *Store) SetMessagePin(ctx context.Context, resolve ResolveSession, channel string, position uint64, pinned, hasImported bool) error {
	if position == 0 || position >= 1<<53 {
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
	if !state.PolicyAnchored || !state.canUseDevice(actor) || state.Channels[channel].Kind != "text" ||
		!state.CanDeliver(actor.ProfileID, channel, position) {
		return ChannelRestricted
	}
	subject := state.Members[actor.ProfileID]
	timeout, err := readTimeout(ctx, tx, subject)
	if err != nil {
		return err
	}
	subject.TimeoutUntil = timeout.Deadline
	now := s.now().UnixMilli()
	if grant := state.CheckGrant(subject, state.scope(state.Channels[channel]), "message.pin", now); grant != Allowed {
		return grant
	}
	retained, err := canReadRetainedMessage(ctx, tx, channel, position, state.firstReadablePosition(channel, actor.ProfileID), hasImported)
	if err != nil {
		return err
	}
	if !retained {
		return ChannelRestricted
	}
	action, query := "message.unpin", "DELETE FROM protected_message_pins WHERE channel_id=? AND position=?"
	if pinned {
		action, query = "message.pin", "INSERT OR IGNORE INTO protected_message_pins(channel_id,position) VALUES(?,?)"
	}
	result, err := tx.ExecContext(ctx, query, channel, position)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 0 {
		if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: action, Kind: "message",
			ObjectID: strconv.FormatUint(position, 10), ChannelID: channel, Position: position}); err != nil {
			return err
		}
	}
	return tx.Commit()
}
