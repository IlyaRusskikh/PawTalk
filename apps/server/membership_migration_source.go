package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const membershipMigrationSchemaVersion = 3

// The version fences legacy startup. The triggers also fence writers that
// opened the API 2 source before maintenance began.
func freezeProtectedMigrationSource(ctx context.Context, tx *sql.Tx, report protectedMigrationReport, backup migrationBackupSnapshot, now time.Time) (protectedMigrationReport, error) {
	tables, err := migrationSourceTables(ctx, tx)
	if err != nil {
		return report, err
	}
	for _, table := range tables {
		for _, operation := range []string{"INSERT", "UPDATE", "DELETE"} {
			name := "protected_migration_" + operation + "_" + table
			statement := fmt.Sprintf(`CREATE TRIGGER %s BEFORE %s ON %s BEGIN
				SELECT RAISE(ABORT, 'PAWTALK_MIGRATION_MAINTENANCE'); END`,
				migrationSQLIdentifier(name), operation, migrationSQLIdentifier(table))
			if _, err := tx.ExecContext(ctx, statement); err != nil {
				return report, err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE protected_migration_source (
		id INTEGER PRIMARY KEY CHECK(id=1),
		owner_profile_id TEXT NOT NULL REFERENCES memberships(profile_id),
		owner_evidence TEXT NOT NULL CHECK(owner_evidence IN ('initial_confirmation','administrator_confirmation')),
		backup_sha256 TEXT NOT NULL CHECK(length(backup_sha256)=64 AND backup_sha256 NOT GLOB '*[^0-9a-f]*'),
		backup_archive_sha256 TEXT NOT NULL CHECK(length(backup_archive_sha256)=64 AND backup_archive_sha256 NOT GLOB '*[^0-9a-f]*'),
		host_identity_sha256 TEXT NOT NULL CHECK(length(host_identity_sha256)=64 AND host_identity_sha256 NOT GLOB '*[^0-9a-f]*'),
		started_at INTEGER NOT NULL,
		imported_profile_bindings INTEGER NOT NULL CHECK(imported_profile_bindings=1)
	) STRICT`); err != nil {
		return report, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_source
		(id,owner_profile_id,owner_evidence,backup_sha256,backup_archive_sha256,host_identity_sha256,started_at,imported_profile_bindings)
		VALUES(1,?,?,?,?,?,?,1)`, report.OwnerProfileID, report.OwnerEvidence, backup.databaseSHA256, backup.archiveSHA256, backup.identitySHA256, now.UnixMilli()); err != nil {
		return report, err
	}
	if _, err := tx.ExecContext(ctx, migrationImportSchema); err != nil {
		return report, err
	}
	if _, err := tx.ExecContext(ctx, migrationRecoverySchema); err != nil {
		return report, err
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", membershipMigrationSchemaVersion)); err != nil {
		return report, err
	}
	report.DataSchema = membershipMigrationSchemaVersion
	report.Maintenance = true
	report.BackupSHA256 = backup.databaseSHA256
	report.BackupArchiveSHA256 = backup.archiveSHA256
	return report, nil
}

// This format is chosen at freeze time, before the initial review digest is
// calculated. A checkpoint created without the column keeps its old digest.
func migrationImportsProfileBindings(ctx context.Context, tx *sql.Tx) (bool, error) {
	var versioned bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pragma_table_info('protected_migration_source')
		WHERE name='imported_profile_bindings')`).Scan(&versioned); err != nil || !versioned {
		return false, err
	}
	var format int
	if err := tx.QueryRowContext(ctx, `SELECT imported_profile_bindings FROM protected_migration_source WHERE id=1`).Scan(&format); err != nil {
		return false, err
	}
	if format != 1 {
		return false, errors.New("invalid migration profile binding format")
	}
	return true, nil
}

func migrationSourceTables(ctx context.Context, tx *sql.Tx) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT name FROM sqlite_schema
		WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return nil, err
		}
		tables = append(tables, table)
	}
	return tables, rows.Err()
}

func migrationSQLIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
