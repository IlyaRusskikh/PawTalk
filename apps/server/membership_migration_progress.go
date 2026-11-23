package main

import (
	"context"
	"database/sql"
)

type migrationImportCount struct {
	Source   int64 `json:"source"`
	Imported int64 `json:"imported"`
}

type migrationImportProgress struct {
	Complete bool                            `json:"complete"`
	Counts   map[string]migrationImportCount `json:"counts"`
}

// Check identity coverage as well as counts. Equal row totals alone cannot
// establish that the staged records cover exactly the frozen source.
func readMigrationImportProgress(ctx context.Context, tx *sql.Tx) (migrationImportProgress, error) {
	progress := migrationImportProgress{Complete: true, Counts: make(map[string]migrationImportCount)}
	for _, relation := range []struct{ kind, source string }{
		{"messages", `SELECT CAST(message_id AS TEXT) AS id FROM messages`},
		{"attachments", `SELECT attachment_id AS id FROM attachments WHERE message_id IS NOT NULL`},
		{"polls", `SELECT poll_id AS id FROM polls`},
	} {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)", relation.kind).Scan(&exists); err != nil {
			return migrationImportProgress{}, err
		}
		source := relation.source
		if !exists {
			source = "SELECT NULL AS id WHERE 0"
		}
		var count migrationImportCount
		var staged int64
		if err := tx.QueryRowContext(ctx, `WITH source AS (`+source+`)
			SELECT (SELECT COUNT(*) FROM source),
			(SELECT COUNT(*) FROM source JOIN protected_migration_records s ON s.kind=?1 AND s.source_id=source.id),
			(SELECT COUNT(*) FROM protected_migration_records WHERE kind=?1)`, relation.kind).
			Scan(&count.Source, &count.Imported, &staged); err != nil {
			return migrationImportProgress{}, err
		}
		progress.Counts[relation.kind] = count
		progress.Complete = progress.Complete && count.Source == count.Imported && count.Imported == staged
	}
	return progress, nil
}
