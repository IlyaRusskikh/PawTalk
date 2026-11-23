package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

type migrationHistoryRecord struct {
	ID           string          `json:"id"`
	Metadata     json.RawMessage `json:"metadata"`
	Nonce        []byte          `json:"nonce,omitempty"`
	Ciphertext   []byte          `json:"ciphertext,omitempty"`
	ArchiveKeyID string          `json:"archiveKeyId,omitempty"`
	Imported     bool            `json:"imported,omitempty"`
}

type migrationHistoryPage struct {
	Records []migrationHistoryRecord `json:"records"`
	Next    string                   `json:"next,omitempty"`
}

type migrationHistoryRelation struct {
	query    string
	key      string
	optional bool
	numeric  bool
	limit    int
}

var migrationHistoryRelations = map[string]migrationHistoryRelation{
	"messages": {
		numeric: true, limit: 64, key: "m.message_id",
		query: `SELECT m.message_id,json_object('messageId',CAST(m.message_id AS TEXT),
			'channelId',m.channel_id,'authorProfileId',m.author_profile_id,'authorDeviceId',m.author_device_id,
			'requestId',m.request_id,'sentAt',m.sent_at,'editedAt',m.edited_at,'keyId',m.crypto_context_id),m.nonce,m.ciphertext
			FROM messages m`,
	},
	"attachments": {
		// An API 2 attachment can contain 50 MiB of encrypted data.
		limit: 1, key: "a.attachment_id",
		query: `SELECT a.attachment_id,json_object('attachmentId',a.attachment_id,
			'channelId',a.channel_id,'messageId',CAST(a.message_id AS TEXT),'authorProfileId',m.author_profile_id,
			'ownerDeviceId',a.owner_device_id,'keyId',a.crypto_context_id,'createdAt',a.created_at),a.nonce,a.ciphertext
			FROM attachments a JOIN messages m ON m.message_id=a.message_id`,
	},
	"polls": {
		optional: true, limit: 64, key: "p.poll_id",
		query: `SELECT p.poll_id,json_object('pollId',p.poll_id,'messageId',CAST(p.message_id AS TEXT),
			'resultMessageId',CAST(p.result_message_id AS TEXT),'channelId',m.channel_id,'authorProfileId',m.author_profile_id,
			'authorDeviceId',m.author_device_id,'resultRequestId',p.result_request_id,'keyId',m.crypto_context_id,
			'optionCount',p.option_count,'multiple',p.multiple,'anonymous',p.anonymous,'intermediate',p.intermediate,
			'closesAt',p.closes_at,'closedAt',p.closed_at,'createHash',lower(hex(p.create_hash))),p.result_nonce,p.result_ciphertext
			FROM polls p JOIN messages m ON m.message_id=p.message_id`,
	},
	"checklists": {
		optional: true, numeric: true, limit: 64, key: "c.message_id",
		query: `SELECT c.message_id,json_object('messageId',CAST(c.message_id AS TEXT),
			'itemIds',json(c.item_ids),'checked',json(c.checked),'everyone',c.everyone),NULL,NULL
			FROM checklists c`,
	},
	"system_messages": {
		optional: true, numeric: true, limit: 64, key: "s.message_id",
		query: `SELECT s.message_id,json_object('messageId',CAST(s.message_id AS TEXT),'kind',s.kind),NULL,NULL
			FROM system_messages s`,
	},
}

// The caller authenticates the migration client in this read transaction.
// Anchor all reads to its selected archive. Source triggers keep cursors valid
// across connections and process restarts while the database is in maintenance.
// Votes are server-side metadata. Pending uploads are outside published history.
func readProtectedMigrationHistory(ctx context.Context, tx *sql.Tx, archiveSHA256, kind, cursor string, limit int) (migrationHistoryPage, error) {
	page := migrationHistoryPage{Records: []migrationHistoryRecord{}}
	relation, ok := migrationHistoryRelations[kind]
	if !ok || limit < 1 || limit > relation.limit || !validHexID(archiveSHA256, 64) {
		return page, errors.New("invalid migration history page parameters")
	}
	primary, err := migrationHistoryPosition(relation, cursor)
	if err != nil {
		return page, err
	}
	var version int
	var checkpoint string
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return page, err
	}
	if version != membershipMigrationSchemaVersion {
		return page, errors.New("migration history requires a source in maintenance")
	}
	if err := tx.QueryRowContext(ctx, "SELECT backup_archive_sha256 FROM protected_migration_source WHERE id=1").Scan(&checkpoint); err != nil {
		return page, err
	}
	if checkpoint != archiveSHA256 {
		return page, errors.New("migration history archive checkpoint changed")
	}
	if relation.optional {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)", kind).Scan(&exists); err != nil || !exists {
			return page, err
		}
	}
	pageQuery := relation.query + " WHERE " + relation.key + ">? ORDER BY " + relation.key + " LIMIT ?"
	// Already committed payloads need only their metadata and durable key binding
	// when the client resumes. Keep the complete source query for import validation.
	rows, err := tx.QueryContext(ctx, `WITH page(id,metadata,nonce,ciphertext) AS (`+pageQuery+`)
		SELECT page.id,page.metadata,CASE WHEN staged.key_id IS NULL THEN page.nonce END,
		CASE WHEN staged.key_id IS NULL THEN page.ciphertext END,COALESCE(k.key_id,''),staged.key_id IS NOT NULL
		FROM page LEFT JOIN protected_migration_records staged ON staged.kind=? AND staged.source_id=CAST(page.id AS TEXT)
		LEFT JOIN protected_migration_channel_keys k ON k.channel_id=json_extract(page.metadata,'$.channelId')
		ORDER BY page.id`, primary, limit, kind)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var record migrationHistoryRecord
		var metadata []byte
		if err := rows.Scan(&record.ID, &metadata, &record.Nonce, &record.Ciphertext, &record.ArchiveKeyID, &record.Imported); err != nil {
			return migrationHistoryPage{}, err
		}
		record.Metadata = metadata
		page.Records = append(page.Records, record)
	}
	if err := rows.Err(); err != nil {
		return migrationHistoryPage{}, err
	}
	if len(page.Records) == limit {
		page.Next = page.Records[len(page.Records)-1].ID
	}
	return page, nil
}

func migrationHistoryPosition(relation migrationHistoryRelation, cursor string) (any, error) {
	if cursor == "" {
		if relation.numeric {
			return int64(0), nil
		}
		return "", nil
	}
	if relation.numeric {
		if id, err := strconv.ParseInt(cursor, 10, 64); err == nil && id > 0 && strconv.FormatInt(id, 10) == cursor {
			return id, nil
		}
	} else if validHexID(cursor, 32) {
		return cursor, nil
	}
	return nil, errors.New("invalid migration history cursor")
}
