package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strconv"
)

const migrationMaxSafePosition int64 = 1<<53 - 1

// The source IDs remain exact row and relation identities. Position is an
// independent channel-local coordinate ordered by the original message cursor.
const migrationMessagePositionsQuery = `
	SELECT channel_id,message_id,ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY message_id) AS position
	FROM messages`

func migrationMessagePositionsDigest(ctx context.Context, tx *sql.Tx, authority migrationAuthority) (string, error) {
	return digestMigrationMessagePositions(ctx, tx, authority, migrationMessagePositionsQuery)
}

func digestMigrationMessagePositions(ctx context.Context, tx *sql.Tx, authority migrationAuthority, query string) (string, error) {
	header, err := signatureFrame("pawtalk-migration-message-positions-v1", authority.serverID, authority.archiveSHA256)
	if err != nil {
		return "", err
	}
	commitment := sha256.New()
	commitment.Write(header)
	rows, err := tx.QueryContext(ctx, query+" ORDER BY channel_id,message_id")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var channel string
		var id, position int64
		if err := rows.Scan(&channel, &id, &position); err != nil {
			return "", err
		}
		if !validHexID(channel, 32) || id <= 0 || position <= 0 || position >= migrationMaxSafePosition {
			return "", memberError(http.StatusConflict, "MIGRATION_INVALID_MESSAGE_POSITION")
		}
		frame, err := signatureFrame(channel, strconv.FormatInt(id, 10), strconv.FormatInt(position, 10))
		if err != nil {
			return "", err
		}
		leaf := sha256.Sum256(frame)
		commitment.Write(leaf[:])
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return hex.EncodeToString(commitment.Sum(nil)), nil
}

func indexApprovedMigrationHistory(ctx context.Context, tx *sql.Tx, authority migrationAuthority, expectedDigest string) error {
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_migration_message_positions (
		channel_id TEXT NOT NULL REFERENCES channels(channel_id),
		message_id INTEGER NOT NULL UNIQUE REFERENCES messages(message_id),
		position INTEGER NOT NULL CHECK(position>0 AND position<9007199254740991),
		PRIMARY KEY(channel_id,position)
	) STRICT`); err != nil {
		return err
	}
	// An approved import is immutable. A repeat validates the existing index.
	var indexed bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM protected_migration_message_positions)").Scan(&indexed); err != nil {
		return err
	}
	if !indexed {
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_message_positions(channel_id,message_id,position)`+
			migrationMessagePositionsQuery); err != nil {
			return err
		}
	}
	digest, err := digestMigrationMessagePositions(ctx, tx, authority,
		"SELECT channel_id,message_id,position FROM protected_migration_message_positions")
	if err != nil {
		return err
	}
	if digest != expectedDigest {
		return memberError(http.StatusConflict, "MIGRATION_INVALID_MESSAGE_POSITION")
	}
	return nil
}
