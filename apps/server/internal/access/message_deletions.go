package access

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"math"
	"strconv"
)

const messageDeletionSchema = `CREATE TABLE IF NOT EXISTS protected_message_deletions (
	sequence INTEGER PRIMARY KEY,
	channel_id TEXT NOT NULL,
	position INTEGER NOT NULL CHECK(position>0),
	author_profile_id TEXT NOT NULL,
	cursor TEXT NOT NULL UNIQUE CHECK(length(cursor)=32),
	UNIQUE(channel_id,position)
) STRICT;
CREATE INDEX IF NOT EXISTS protected_message_deletions_channel ON protected_message_deletions(channel_id,sequence);`

// EnsureMessageDeletionSchema also upgrades already activated databases.
func EnsureMessageDeletionSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, messageDeletionSchema+moderationCleanupSchema)
	return err
}

var ErrMessageKind = errors.New("protected message requires a dedicated deletion action")

// ResolveImportedMessage resolves the effective author of a retained imported
// object on the same transaction. Protected message positions are shared by
// both stores. An unrecognized position returns sql.ErrNoRows.
type ResolveImportedMessage func(context.Context, *sql.Tx, string, uint64, int64) (string, error)

func (s *Store) DeleteMessage(ctx context.Context, resolve ResolveSession, imported ResolveImportedMessage, channelID string, position uint64) error {
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
	if !state.PolicyAnchored || !state.canUseDevice(actor) || !state.CanDeliver(actor.ProfileID, channelID, position) {
		return ChannelRestricted
	}
	var author string
	err = tx.QueryRowContext(ctx, "SELECT author_profile_id FROM protected_message_deletions WHERE channel_id=? AND position=?",
		channelID, position).Scan(&author)
	existing := err == nil
	if errors.Is(err, sql.ErrNoRows) {
		var closedPoll bool
		err = tx.QueryRowContext(ctx, `SELECT m.profile_id,EXISTS(SELECT 1 FROM protected_polls p
			WHERE p.channel_id=m.channel_id AND p.position=m.position AND (p.closed_at IS NOT NULL OR p.closes_at<=? OR
				EXISTS(SELECT 1 FROM protected_poll_closures c WHERE c.channel_id=p.channel_id AND c.position=p.position)))
			FROM protected_messages m WHERE m.channel_id=? AND m.position=?`, s.now().UnixMilli(), channelID, position).Scan(&author, &closedPoll)
		if err == nil && closedPoll {
			return ErrMessageKind
		}
		if errors.Is(err, sql.ErrNoRows) && imported != nil {
			author, err = imported(ctx, tx, channelID, position, s.now().UnixMilli())
		}
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelRestricted
	}
	if err != nil {
		return err
	}
	if author != actor.ProfileID {
		allowed := state.CheckGrant(state.Members[actor.ProfileID], state.scope(state.Channels[channelID]), "message.delete-other", s.now().UnixMilli())
		if allowed != Allowed {
			return allowed
		}
	}
	if existing {
		return nil
	}
	if err := deleteAuditedMessage(ctx, tx, actor.ProfileID, channelID, position, author, s.now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

func deleteAuditedMessage(ctx context.Context, tx *sql.Tx, actor, channel string, position uint64, author string, now int64) error {
	if err := removeRetainedMessage(ctx, tx, channel, position, author); err != nil {
		return err
	}
	return recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor, Action: "message.delete", Kind: "message",
		ObjectID: strconv.FormatUint(position, 10), ChannelID: channel, Position: position})
}

func removeRetainedMessage(ctx context.Context, tx *sql.Tx, channelID string, position uint64, author string) error {
	var cursor [16]byte
	if _, err := rand.Read(cursor[:]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_message_deletions(channel_id,position,author_profile_id,cursor)
		VALUES(?,?,?,?)`, channelID, position, author, hex.EncodeToString(cursor[:])); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_timeline_changes(cursor,channel_id,position,revision)
		VALUES(?,?,?,0)`, hex.EncodeToString(cursor[:]), channelID, position); err != nil {
		return err
	}
	// Keep the original receipt and nonce reservation. Retrying a send must
	// not recreate a deleted message, including after key rotation.
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_messages WHERE channel_id=? AND position=?", channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM protected_attachment_blocks WHERE id IN
		(SELECT id FROM protected_attachments WHERE channel_id=? AND position=?)`, channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_text_revisions WHERE channel_id=? AND position=?", channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_message_pins WHERE channel_id=? AND position=?", channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_message_replies WHERE channel_id=? AND reply_position=?", channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_checklist_state WHERE channel_id=? AND position=?", channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_checklists WHERE channel_id=? AND position=?", channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_poll_ballots WHERE channel_id=? AND position=?", channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_poll_closures SET counts='[]',total=0 WHERE channel_id=? AND position=?", channelID, position); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_poll_results SET record='' WHERE channel_id=? AND position=?", channelID, position); err != nil {
		return err
	}
	return nil
}

type HistoryWindow struct {
	First          uint64             `json:"first"`
	Last           uint64             `json:"last"`
	Cursor         string             `json:"cursor"`
	Removed        []uint64           `json:"removed"`
	More           bool               `json:"more,omitempty"`
	CanDeleteOther bool               `json:"canDeleteOther"`
	CanDeletePoll  bool               `json:"canDeletePoll,omitempty"`
	CanCreateList  bool               `json:"canCreateList,omitempty"`
	CanCreatePoll  bool               `json:"canCreatePoll,omitempty"`
	CanSend        bool               `json:"canSend"`
	CanAttach      bool               `json:"canAttach,omitempty"`
	CanSendVoice   bool               `json:"canSendVoice,omitempty"`
	Edits          []HistoryEdit      `json:"edits"`
	Pins           PinnedMessagesPage `json:"pins"`
}

func lastRetainedPosition(ctx context.Context, conn *sql.Conn, channel string, first, next uint64, hasImported bool) (uint64, error) {
	if first >= next {
		return 0, nil
	}
	positions := `SELECT position FROM protected_messages WHERE channel_id=? AND position>=? AND position<?
		UNION ALL SELECT position FROM protected_poll_results WHERE channel_id=? AND position>=? AND position<?`
	args := []any{channel, channel, first, next, channel, first, next}
	if hasImported {
		positions += ` UNION ALL SELECT position FROM protected_migration_message_positions
			WHERE channel_id=? AND position>=? AND position<?`
		args = append(args, channel, first, next)
	}
	args = append(args, first)
	if hasImported {
		args = append(args, first)
	}
	var last uint64
	err := conn.QueryRowContext(ctx, `SELECT p.position FROM
		(SELECT position, ? AS channel_id FROM (`+positions+`)) p WHERE `+retainedMessageOriginal(hasImported)+
		` ORDER BY p.position DESC LIMIT 1`, args...).Scan(&last)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return last, err
}

type HistoryEdit struct {
	Position uint64 `json:"position"`
	Revision uint64 `json:"revision"`
}

const timelineChangePageSize = 64

func (s *Store) DispatchHistoryWindow(ctx context.Context, resolve ResolveSession, channel string, after *string, hasImported bool, deliver func(HistoryWindow) error) error {
	return s.dispatchHistory(ctx, resolve, channel, func(conn *sql.Conn, state State, actor Principal, first, next uint64) error {
		return readHistoryWindow(ctx, conn, state, actor, channel, first, next, after, hasImported, s.now().UnixMilli(), deliver)
	})
}

func readHistoryWindow(ctx context.Context, conn *sql.Conn, state State, actor Principal, channel string,
	first, next uint64, after *string, hasImported bool, now int64, deliver func(HistoryWindow) error) error {
	scope, subject := state.scope(state.Channels[channel]), state.Members[actor.ProfileID]
	timeout, err := readTimeout(ctx, conn, subject)
	if err != nil {
		return err
	}
	subject.TimeoutUntil = timeout.Deadline
	window := HistoryWindow{First: first, Removed: []uint64{}, Edits: []HistoryEdit{},
		CanDeleteOther: state.CheckGrant(subject, scope, "message.delete-other", now) == Allowed,
		CanDeletePoll:  state.CheckGrant(subject, scope, "poll.delete-completed", now) == Allowed,
		CanCreateList:  state.CheckGrant(subject, scope, "checklist.create", now) == Allowed,
		CanCreatePoll:  state.CheckGrant(subject, scope, "poll.create", now) == Allowed,
		CanSend:        state.CheckGrant(subject, scope, "message.send", now) == Allowed,
		CanAttach:      state.CheckGrant(subject, scope, "message.attach", now) == Allowed,
		CanSendVoice:   state.CheckGrant(subject, scope, "message.voice", now) == Allowed}
	if after == nil {
		window.Last, err = lastRetainedPosition(ctx, conn, channel, first, next, hasImported)
		if err != nil {
			return err
		}
	}
	canPin := state.CheckGrant(subject, scope, "message.pin", now) == Allowed
	window.Pins, err = readPinnedMessages(ctx, conn, channel, hasImported, canPin, first, next, 0)
	if err != nil {
		return err
	}
	filter := pollResultEventFilter("e", "?", hasImported)
	args := []any{channel, first, next, first}
	if hasImported {
		args = append(args, first)
	}
	if after == nil {
		// New timelines start before loading any messages. The opaque
		// watermark discloses neither hidden positions nor event counts.
		err := conn.QueryRowContext(ctx, `SELECT cursor FROM protected_timeline_changes e
				WHERE channel_id=? AND position>=? AND position<?`+filter+` ORDER BY sequence DESC LIMIT 1`, args...).Scan(&window.Cursor)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		return deliver(window)
	}
	var sequence int64
	if *after != "" {
		err := conn.QueryRowContext(ctx, "SELECT sequence FROM protected_timeline_changes WHERE channel_id=? AND cursor=?",
			channel, *after).Scan(&sequence)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil {
			window.Cursor = *after
		}
	}
	args = append(args, sequence, timelineChangePageSize+1)
	rows, err := conn.QueryContext(ctx, `SELECT position,revision,cursor FROM protected_timeline_changes e
			WHERE channel_id=? AND position>=? AND position<?`+filter+` AND sequence>? ORDER BY sequence LIMIT ?`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if len(window.Removed)+len(window.Edits) == timelineChangePageSize {
			window.More = true
			break
		}
		var change HistoryEdit
		if err := rows.Scan(&change.Position, &change.Revision, &window.Cursor); err != nil {
			return err
		}
		if change.Revision == 0 {
			window.Removed = append(window.Removed, change.Position)
		} else {
			window.Edits = append(window.Edits, change)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return deliver(window)
}
