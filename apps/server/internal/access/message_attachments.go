package access

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

const AttachmentBlockSize = 1024 * 1024
const MaxAttachmentCiphertext = 50*1024*1024 + 16
const maxPendingAttachments = 20
const pendingAttachmentTTL = 30 * time.Minute

var ErrAttachmentConflict = errors.New("protected attachment conflict")
var ErrAttachmentLimit = errors.New("protected attachment limit")

type MessageAttachment struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

type AttachmentBlock struct {
	Offset int    `json:"offset"`
	Total  int    `json:"total"`
	Bytes  []byte `json:"bytes"`
}

func EnsureAttachmentSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_attachments (
		id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, device_id TEXT NOT NULL, profile_id TEXT NOT NULL,
		kind TEXT NOT NULL, total INTEGER NOT NULL, created_at INTEGER NOT NULL, position INTEGER, ordinal INTEGER
	);
	CREATE INDEX IF NOT EXISTS protected_attachment_pending ON protected_attachments(created_at) WHERE position IS NULL;
	CREATE INDEX IF NOT EXISTS protected_attachment_uploader ON protected_attachments(device_id) WHERE position IS NULL;
	CREATE UNIQUE INDEX IF NOT EXISTS protected_attachment_parent ON protected_attachments(channel_id,position,ordinal) WHERE position IS NOT NULL;
	CREATE TABLE IF NOT EXISTS protected_attachment_blocks (
		id TEXT NOT NULL REFERENCES protected_attachments(id) ON DELETE CASCADE,
		offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(id,offset)
	) WITHOUT ROWID`)
	return err
}

func (ref MessageAttachment) grant() string {
	switch ref.Kind {
	case "file":
		return "message.attach"
	case "voice":
		return "message.voice"
	default:
		return ""
	}
}

func (ref MessageAttachment) valid() bool {
	return len(ref.ID) == 32 && strings.Trim(ref.ID, "0123456789abcdef") == "" && ref.grant() != ""
}

func validMessageAttachments(refs []MessageAttachment) bool {
	if len(refs) > maxPendingAttachments {
		return false
	}
	seen := make(map[string]bool, len(refs))
	for _, ref := range refs {
		if !ref.valid() || seen[ref.ID] {
			return false
		}
		seen[ref.ID] = true
	}
	return true
}

func validAttachmentOffset(offset int) bool {
	return offset >= 0 && offset < MaxAttachmentCiphertext && offset%AttachmentBlockSize == 0
}

func (s *Store) PutAttachmentBlock(ctx context.Context, resolve ResolveSession, channelID string, ref MessageAttachment, block AttachmentBlock,
	checkStorage func(context.Context, *sql.Tx) error) error {
	if !ref.valid() || !validAttachmentOffset(block.Offset) || block.Total < 17 || block.Total > MaxAttachmentCiphertext ||
		block.Offset >= block.Total || len(block.Bytes) != min(AttachmentBlockSize, block.Total-block.Offset) {
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
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	channel, exists := state.Channels[channelID]
	if !exists || channel.Kind != "text" || !state.canUseDevice(principal) || !state.CanDeliver(principal.ProfileID, channelID, 0) {
		return ChannelRestricted
	}
	now := s.now().UnixMilli()
	actor := state.Members[principal.ProfileID]
	timeout, err := readTimeout(ctx, tx, actor)
	if err != nil {
		return err
	}
	actor.TimeoutUntil = timeout.Deadline
	if allowed := state.CheckGrant(actor, state.scope(channel), ref.grant(), now); allowed != Allowed {
		return allowed
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_attachments WHERE position IS NULL AND created_at<=?", now-pendingAttachmentTTL.Milliseconds()); err != nil {
		return err
	}
	var storedChannel, kind string
	var stored Principal
	var total int
	var position sql.NullInt64
	err = tx.QueryRowContext(ctx, `SELECT channel_id,device_id,profile_id,kind,total,position FROM protected_attachments WHERE id=?`, ref.ID).
		Scan(&storedChannel, &stored.DeviceID, &stored.ProfileID, &kind, &total, &position)
	if errors.Is(err, sql.ErrNoRows) {
		if block.Offset != 0 {
			return ErrAttachmentConflict
		}
		var pending int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM protected_attachments WHERE device_id=? AND position IS NULL`, principal.DeviceID).Scan(&pending); err != nil {
			return err
		}
		if pending >= maxPendingAttachments {
			return ErrAttachmentLimit
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_attachments(id,channel_id,device_id,profile_id,kind,total,created_at) VALUES(?,?,?,?,?,?,?)`,
			ref.ID, channelID, principal.DeviceID, principal.ProfileID, ref.Kind, block.Total, now); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if position.Valid || storedChannel != channelID || stored != principal || kind != ref.Kind || total != block.Total {
		return ErrAttachmentConflict
	}
	var previous []byte
	err = tx.QueryRowContext(ctx, `SELECT bytes FROM protected_attachment_blocks WHERE id=? AND offset=?`, ref.ID, block.Offset).Scan(&previous)
	if err == nil {
		if !bytes.Equal(previous, block.Bytes) {
			return ErrAttachmentConflict
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_attachment_blocks(id,offset,bytes) VALUES(?,?,?)`, ref.ID, block.Offset, block.Bytes); err != nil {
		return err
	}
	if checkStorage != nil {
		if err := checkStorage(ctx, tx); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func bindMessageAttachments(ctx context.Context, tx *sql.Tx, attempt MessageAttempt, principal Principal, position uint64, now int64) error {
	for ordinal, ref := range attempt.Attachments {
		result, err := tx.ExecContext(ctx, `UPDATE protected_attachments SET position=?,ordinal=?
			WHERE id=? AND channel_id=? AND device_id=? AND profile_id=? AND kind=? AND position IS NULL AND created_at>?
			AND (SELECT count(*) FROM protected_attachment_blocks b WHERE b.id=protected_attachments.id)=(total+?-1)/?`,
			position, ordinal, ref.ID, attempt.ChannelID, principal.DeviceID, principal.ProfileID, ref.Kind,
			now-pendingAttachmentTTL.Milliseconds(), AttachmentBlockSize, AttachmentBlockSize)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return ErrAttachmentConflict
		}
	}
	return nil
}

func (s *Store) DispatchAttachmentBlock(ctx context.Context, resolve ResolveSession, channelID string, position uint64, id string, offset int,
	deliver func(AttachmentBlock) error) error {
	if !(MessageAttachment{ID: id, Kind: "file"}).valid() || !validAttachmentOffset(offset) {
		return InvalidAction
	}
	return s.DispatchHistory(ctx, resolve, channelID, func(conn *sql.Conn, first, next uint64) error {
		if position < first || position >= next {
			return ChannelRestricted
		}
		block := AttachmentBlock{Offset: offset}
		err := conn.QueryRowContext(ctx, `SELECT a.total,b.bytes FROM protected_attachments a
			JOIN protected_messages m ON m.channel_id=a.channel_id AND m.position=a.position
			JOIN protected_attachment_blocks b ON b.id=a.id AND b.offset=?
			WHERE a.channel_id=? AND a.position=? AND a.id=?`, offset, channelID, position, id).Scan(&block.Total, &block.Bytes)
		if errors.Is(err, sql.ErrNoRows) {
			return ChannelRestricted
		}
		if err != nil {
			return err
		}
		return deliver(block)
	})
}
