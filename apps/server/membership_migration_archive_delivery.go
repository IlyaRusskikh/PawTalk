package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"net/http"
	"strings"

	"pawtalk/server/internal/access"
)

type importedProtectedMessage struct {
	Position          uint64                `json:"position"`
	Packet            migratedHistoryPacket `json:"packet"`
	EffectiveAuthor   string                `json:"effectiveAuthor"`
	DedicatedDeletion bool                  `json:"dedicatedDeletion,omitempty"`
	CannotEdit        bool                  `json:"cannotEdit,omitempty"`
	CompletedPoll     bool                  `json:"completedPoll,omitempty"`
	OriginalPoll      uint64                `json:"originalPollPosition,omitempty"`
	Revision          uint64                `json:"revision,omitempty"`
}

type importedProtectedPage struct {
	First    uint64                     `json:"first"`
	Messages []importedProtectedMessage `json:"messages"`
	Next     uint64                     `json:"next,omitempty"`
}

type importedMessageReference struct {
	ID       string `json:"id"`
	Position uint64 `json:"position"`
}

const importedPollCompleted = `(p.closed_at IS NOT NULL OR p.closes_at<=? OR EXISTS(
	SELECT 1 FROM protected_poll_closures c WHERE c.channel_id=i.channel_id AND c.position=i.position))`
const importedCompletedPoll = `EXISTS(SELECT 1 FROM polls p WHERE p.message_id=m.message_id AND ` + importedPollCompleted + `)`

const importedDedicatedDeletion = `(EXISTS(SELECT 1 FROM system_messages s WHERE s.message_id=m.message_id)
	OR EXISTS(SELECT 1 FROM polls p WHERE p.result_message_id=m.message_id)
	OR ` + importedCompletedPoll + `)`

const importedCannotEdit = `(EXISTS(SELECT 1 FROM system_messages s WHERE s.message_id=m.message_id)
	OR EXISTS(SELECT 1 FROM polls p WHERE p.message_id=m.message_id OR p.result_message_id=m.message_id))`

func resolveImportedProtectedMessage(ctx context.Context, tx *sql.Tx, channel string, position uint64, now int64) (string, error) {
	var author string
	var dedicated bool
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(b.target_profile_id,m.author_profile_id),`+importedDedicatedDeletion+`
		FROM protected_migration_message_positions i
		JOIN messages m ON m.message_id=i.message_id AND m.channel_id=i.channel_id
		JOIN protected_migration_records r ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
		LEFT JOIN profile_bindings b ON b.source_profile_id=m.author_profile_id
		WHERE i.channel_id=? AND i.position=?`, now, channel, position).Scan(&author, &dedicated)
	if err == nil && dedicated {
		return "", access.ErrMessageKind
	}
	return author, err
}

func resolveImportedCompletedPoll(ctx context.Context, tx *sql.Tx, channel string, position uint64, now int64) (access.CompletedPollMessages, error) {
	var poll access.CompletedPollMessages
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(b.target_profile_id,m.author_profile_id),
		CASE WHEN p.result_message_id IS NULL THEN 0 ELSE iresult.position END,
		COALESCE(br.target_profile_id,mresult.author_profile_id,'')
		FROM protected_migration_message_positions i
		JOIN messages m ON m.message_id=i.message_id AND m.channel_id=i.channel_id
		JOIN polls p ON p.message_id=m.message_id
		JOIN protected_migration_records x ON x.kind='messages' AND x.source_id=CAST(m.message_id AS TEXT) AND x.channel_id=i.channel_id
		LEFT JOIN profile_bindings b ON b.source_profile_id=m.author_profile_id
		LEFT JOIN protected_migration_message_positions iresult ON iresult.message_id=p.result_message_id AND iresult.channel_id=i.channel_id
		LEFT JOIN messages mresult ON mresult.message_id=iresult.message_id AND mresult.channel_id=i.channel_id
		LEFT JOIN profile_bindings br ON br.source_profile_id=mresult.author_profile_id
		WHERE i.channel_id=? AND i.position=? AND `+importedPollCompleted, channel, position, now).
		Scan(&poll.Author, &poll.Result, &poll.ResultAuthor)
	return poll, err
}

func (s *membershipStore) dispatchImportedProtectedHistory(ctx context.Context, resolve access.ResolveSession, channelID string,
	after uint64, limit int, write func(importedProtectedPage) error) error {
	if !validHexID(channelID, 32) || after >= uint64(migrationMaxSafePosition) || limit < 1 || limit > 32 {
		return memberError(http.StatusBadRequest, "INVALID_MIGRATION_PAGE")
	}
	return access.NewStoreWithClock(s.db, s.now).DispatchHistory(ctx, resolve, channelID, func(conn *sql.Conn, first, next uint64) error {
		page, err := readImportedProtectedPage(ctx, conn, channelID, first, max(after+1, first), next, limit, s.now().UnixMilli())
		if err != nil {
			return err
		}
		page.First = first
		if err := ctx.Err(); err != nil {
			return err
		}
		return write(page)
	})
}

func readImportedMessageReferences(ctx context.Context, conn *sql.Conn, channel string, first, next uint64,
	ids []int64, hasImported bool) ([]importedMessageReference, error) {
	references := make([]importedMessageReference, 0, len(ids))
	if !hasImported || first >= next || len(ids) == 0 {
		return references, nil
	}
	// Omit removed, missing and inaccessible IDs with the same response.
	query := `SELECT r.source_id,i.position
		FROM protected_migration_message_positions i JOIN protected_migration_records r
		ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
		WHERE i.channel_id=? AND i.position>=? AND i.position<?
		AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=i.channel_id AND d.position=i.position)
		AND ` + access.ImportedPollResultAllowed("?", true) + ` AND i.message_id IN (` + strings.Repeat("?,", len(ids)-1) + "?)"
	params := []any{channel, first, next, first}
	for _, id := range ids {
		params = append(params, id)
	}
	rows, err := conn.QueryContext(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var reference importedMessageReference
		if err := rows.Scan(&reference.ID, &reference.Position); err != nil {
			return nil, err
		}
		references = append(references, reference)
	}
	return references, rows.Err()
}

func readImportedProtectedPage(ctx context.Context, conn *sql.Conn, channelID string, first, start, next uint64, limit int, now int64) (importedProtectedPage, error) {
	page := importedProtectedPage{Messages: make([]importedProtectedMessage, 0, limit)}
	if start >= next {
		return page, nil
	}
	rows, err := conn.QueryContext(ctx, `SELECT i.position,r.source_id,r.key_id,r.metadata,r.source_digest,r.nonce,r.ciphertext,
		r.migrator_device_id,r.signature,source.backup_archive_sha256,COALESCE(b.target_profile_id,m.author_profile_id),`+importedDedicatedDeletion+`,`+importedCannotEdit+`,`+importedCompletedPoll+`,
		COALESCE((SELECT original.position FROM polls p JOIN protected_migration_message_positions original
			ON original.channel_id=i.channel_id AND original.message_id=p.message_id WHERE p.result_message_id=i.message_id),0),
		COALESCE((SELECT MAX(x.revision) FROM protected_text_revisions x WHERE x.channel_id=i.channel_id AND x.position=i.position),0)
		FROM protected_migration_message_positions i JOIN protected_migration_records r
		ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
		JOIN messages m ON m.message_id=i.message_id AND m.channel_id=i.channel_id
		LEFT JOIN profile_bindings b ON b.source_profile_id=m.author_profile_id
		CROSS JOIN protected_migration_source source
		WHERE source.id=1 AND i.channel_id=? AND i.position>=? AND i.position<?
		AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=i.channel_id AND d.position=i.position)
		AND `+access.ImportedPollResultAllowed("?", true)+`
		ORDER BY i.position LIMIT ?`, now, now, channelID, start, next, first, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		if len(page.Messages) == limit {
			page.Next = page.Messages[limit-1].Position
			break
		}
		message := importedProtectedMessage{Packet: migratedHistoryPacket{Kind: "messages", Version: 1, Generation: 1}}
		packet := &message.Packet
		var metadata, signature []byte
		if err := rows.Scan(&message.Position, &packet.ID, &packet.KeyID, &metadata, &packet.SourceDigest, &packet.Nonce,
			&packet.Ciphertext, &packet.MigratorDeviceID, &signature, &packet.ArchiveSHA256,
			&message.EffectiveAuthor, &message.DedicatedDeletion, &message.CannotEdit, &message.CompletedPoll,
			&message.OriginalPoll, &message.Revision); err != nil {
			return importedProtectedPage{}, err
		}
		packet.Metadata = metadata
		packet.Signature = base64.RawURLEncoding.EncodeToString(signature)
		page.Messages = append(page.Messages, message)
	}
	return page, rows.Err()
}
