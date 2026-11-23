package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type protectedMigrationReport struct {
	ServerID            string           `json:"serverId"`
	DataSchema          int              `json:"dataSchema"`
	Maintenance         bool             `json:"maintenance,omitempty"`
	BackupSHA256        string           `json:"backupSha256,omitempty"`
	BackupArchiveSHA256 string           `json:"backupArchiveSha256,omitempty"`
	Inventory           map[string]int64 `json:"inventory"`
	OwnerProfileID      string           `json:"ownerProfileId,omitempty"`
	OwnerEvidence       string           `json:"ownerEvidence,omitempty"`
	OwnerBlocker        string           `json:"ownerBlocker,omitempty"`
}

type migrationIdentity struct {
	memberIdentity
	redeemedAt sql.NullInt64
	bootstrap  bool
}

// The inspection uses a consistent, read-only source snapshot. It never
// initializes the database or installs protected tables.
func inspectProtectedMigration(ctx context.Context, path string, now time.Time) (protectedMigrationReport, error) {
	var report protectedMigrationReport
	db, err := openMembershipReadOnly(path)
	if err != nil {
		return report, err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return report, err
	}
	defer tx.Rollback()
	report, err = readProtectedMigrationSource(ctx, tx, now)
	if err != nil {
		return report, err
	}
	return report, tx.Commit()
}

func readProtectedMigrationSource(ctx context.Context, tx *sql.Tx, now time.Time) (protectedMigrationReport, error) {
	var report protectedMigrationReport
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&report.DataSchema); err != nil {
		return report, err
	}
	var maintenance bool
	switch report.DataSchema {
	case membershipSchemaVersion:
	case membershipMigrationSchemaVersion:
		maintenance = true
	default:
		return report, errors.New("migration inspection requires an API 2 source database")
	}
	var declared int
	var protected, checkpoint, migrationAnchor bool
	if err := tx.QueryRowContext(ctx, `SELECT server_id,schema_version,
		EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='protected_policy' COLLATE NOCASE),
		EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='protected_migration_source' COLLATE NOCASE),
		EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='protected_migration_policy_anchor' COLLATE NOCASE)
		FROM server_state WHERE id=1`).Scan(&report.ServerID, &declared, &protected, &checkpoint, &migrationAnchor); err != nil {
		return report, err
	}
	if declared != membershipSchemaVersion || protected != migrationAnchor || (migrationAnchor && !maintenance) ||
		checkpoint != maintenance || !validHexID(report.ServerID, 32) {
		return report, errors.New("database is not an API 2 migration source")
	}
	var check string
	if err := tx.QueryRowContext(ctx, "PRAGMA quick_check(1)").Scan(&check); err != nil {
		return report, err
	}
	var brokenLinks bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)").Scan(&brokenLinks); err != nil {
		return report, err
	}
	if check != "ok" || brokenLinks {
		return report, errors.New("migration source failed SQLite integrity checks")
	}
	report.Inventory = make(map[string]int64)
	for _, table := range []string{"memberships", "profile_bindings", "channels", "messages", "attachments", "polls", "poll_votes", "checklists", "system_messages"} {
		var count int64
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", table).Scan(&exists); err != nil {
			return report, err
		}
		if exists {
			if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
				return report, err
			}
		} else {
			switch table {
			case "memberships", "profile_bindings", "channels", "messages", "attachments":
				return report, fmt.Errorf("migration source is missing %s", table)
			}
		}
		report.Inventory[table] = count
	}
	if err := inspectMigrationHistoryLinks(ctx, tx, report.Inventory); err != nil {
		return report, err
	}
	report.Maintenance = maintenance
	if maintenance {
		err := tx.QueryRowContext(ctx, "SELECT owner_profile_id,owner_evidence,backup_sha256,backup_archive_sha256 FROM protected_migration_source WHERE id=1").
			Scan(&report.OwnerProfileID, &report.OwnerEvidence, &report.BackupSHA256, &report.BackupArchiveSHA256)
		return report, err
	}
	store := &membershipStore{now: func() time.Time { return now }}
	err := store.inspectMigrationOwner(ctx, tx, &report)
	return report, err
}

func inspectMigrationHistoryLinks(ctx context.Context, tx *sql.Tx, inventory map[string]int64) error {
	var published int64
	var invalid bool
	err := tx.QueryRowContext(ctx, `SELECT COUNT(message_id), EXISTS(
		SELECT 1 FROM attachments a JOIN messages m ON m.message_id=a.message_id
		WHERE a.channel_id<>m.channel_id OR a.owner_device_id<>m.author_device_id) FROM attachments`).Scan(&published, &invalid)
	if err != nil {
		return err
	}
	if invalid {
		return errors.New("migration source has an attachment with an inconsistent channel or author device")
	}
	inventory["published_attachments"] = published
	inventory["pending_attachments"] = inventory["attachments"] - published
	if inventory["polls"] == 0 {
		return nil
	}
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM polls p
		JOIN messages m ON m.message_id=p.message_id JOIN messages result ON result.message_id=p.result_message_id
		WHERE p.message_id=p.result_message_id OR result.channel_id<>m.channel_id OR result.author_profile_id<>m.author_profile_id
		OR result.author_device_id<>m.author_device_id OR result.request_id<>p.result_request_id
		OR result.crypto_context_id<>m.crypto_context_id)`).Scan(&invalid)
	if err != nil {
		return err
	}
	if invalid {
		return errors.New("migration source has a poll result with inconsistent provenance")
	}
	return nil
}

func migrationIdentities(ctx context.Context, tx *sql.Tx) ([]migrationIdentity, error) {
	rows, err := tx.QueryContext(ctx, `WITH successful AS (
		SELECT a.device_id, MIN(r.redeemed_at) AS joined, MAX(a.invite_kind='bootstrap') AS bootstrap
		FROM invite_attempts a JOIN invite_redemptions r USING(attempt_id) GROUP BY a.device_id
	)
	SELECT d.device_id,d.original_profile_id,s.joined,COALESCE(s.bootstrap,0)
	FROM devices d LEFT JOIN successful s USING(device_id)
	WHERE s.bootstrap=1 OR EXISTS(SELECT 1 FROM memberships m WHERE m.profile_id=d.original_profile_id)
	ORDER BY s.bootstrap DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var identities []migrationIdentity
	for rows.Next() {
		var identity migrationIdentity
		if err := rows.Scan(&identity.DeviceID, &identity.ProfileID, &identity.redeemedAt, &identity.bootstrap); err != nil {
			return nil, err
		}
		identities = append(identities, identity)
	}
	return identities, rows.Err()
}

func (s *membershipStore) inspectMigrationOwner(ctx context.Context, tx *sql.Tx, report *protectedMigrationReport) error {
	var bootstrapCount, mismatches int
	err := tx.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM invite_redemptions r JOIN invite_attempts a USING(attempt_id) WHERE a.invite_kind='bootstrap'),
		(SELECT COUNT(*) FROM invite_attempts a LEFT JOIN invite_redemptions r USING(attempt_id) WHERE
			(a.state='confirmed') <> (r.attempt_id IS NOT NULL) OR
			(r.attempt_id IS NOT NULL AND (a.profile_id<>r.profile_id OR a.completed_at IS NOT r.redeemed_at OR
				NOT EXISTS(SELECT 1 FROM devices d WHERE d.device_id=a.device_id AND d.original_profile_id=a.profile_id)))) +
		(SELECT COUNT(*) FROM invite_redemptions r LEFT JOIN invite_attempts a USING(attempt_id) WHERE a.attempt_id IS NULL)`).
		Scan(&bootstrapCount, &mismatches)
	if err != nil {
		return err
	}
	if bootstrapCount != 1 || mismatches != 0 {
		report.OwnerBlocker = "JOIN_EVIDENCE_MISSING_OR_INCONSISTENT"
		return nil
	}
	identities, err := migrationIdentities(ctx, tx)
	if err != nil {
		return err
	}
	admins := make(map[string]sql.NullInt64)
	for _, identity := range identities {
		member, err := s.resolveAccessTx(ctx, tx, identity.memberIdentity)
		if err != nil {
			var denial *membershipError
			if errors.As(err, &denial) && (denial.Code == "NOT_A_MEMBER" || denial.Code == "BANNED") {
				continue
			}
			return err
		}
		if identity.bootstrap {
			report.OwnerProfileID, report.OwnerEvidence = member.EffectiveProfileID, "initial_confirmation"
			return nil
		}
		if !migrationAdministrator(member) {
			continue
		}
		earliest := admins[member.EffectiveProfileID]
		if identity.redeemedAt.Valid && (!earliest.Valid || identity.redeemedAt.Int64 < earliest.Int64) {
			earliest = identity.redeemedAt
		}
		admins[member.EffectiveProfileID] = earliest
	}
	var earliest sql.NullInt64
	var selected string
	tied := false
	for profile, joined := range admins {
		if !joined.Valid {
			report.OwnerBlocker = "ADMIN_JOIN_EVIDENCE_MISSING"
			return nil
		}
		if !earliest.Valid || joined.Int64 < earliest.Int64 {
			earliest, selected, tied = joined, profile, false
		} else if joined.Int64 == earliest.Int64 {
			tied = true
		}
	}
	switch {
	case !earliest.Valid:
		report.OwnerBlocker = "NO_ELIGIBLE_ADMINISTRATOR"
	case tied:
		report.OwnerBlocker = "ADMIN_JOIN_ORDER_AMBIGUOUS"
	default:
		report.OwnerProfileID, report.OwnerEvidence = selected, "administrator_confirmation"
	}
	return nil
}

func migrationAdministrator(member memberAccess) bool {
	if member.Role != "admin" {
		return false
	}
	for _, permission := range []string{"chat.read", "chat.write", "voice.join", "invite.create", "invite.revoke.own",
		"invite.revoke.any", "channel.manage", "role.manage", "member.kick", "member.ban"} {
		if !member.allows(permission) {
			return false
		}
	}
	return true
}
