package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedAuditPruneKeepsMigrationKeyMaterial(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_800_000_000, 0)
	server := testMembershipStore(t)
	server.now = func() time.Time { return now }
	store, _, owner, _ := protectedTestState(t, server)
	draft, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	proof, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, draft))
	if err != nil {
		t.Fatal(err)
	}

	var channel string
	if err := server.db.QueryRowContext(ctx, "SELECT channel_id FROM channels WHERE protected_kind='default_text'").
		Scan(&channel); err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := server.db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Exercise the real schemas and associations with synthetic package bytes.
	exec(migrationImportSchema)
	exec(migrationRecoverySchema)
	exec(migrationRecoveryEpochSchema)
	key, recoveryID, epochDigest := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	exec(`INSERT INTO protected_migration_channel_keys(channel_id,key_id) VALUES(?,?)`, channel, key)
	exec(`INSERT INTO protected_migration_owner_recovery(id,profile_id,recovery_id,signing_key,agreement_key)
		VALUES(1,?,?,?,?)`, owner.Access.EffectiveProfileID, recoveryID, strings.Repeat("d", 64), strings.Repeat("e", 64))
	exec(`INSERT INTO protected_migration_recovery_packages(channel_id,key_id,recovery_id,device_id,ciphertext,signature,confirmation)
		VALUES(?,?,?,?,zeroblob(80),zeroblob(64),zeroblob(64))`, channel, key, recoveryID, owner.Access.DeviceID)
	exec(`INSERT INTO protected_epochs(channel_id,purpose,generation,key_id,task_id,digest,record)
		VALUES(?,'archive',1,?, ?,?, CAST('{}' AS BLOB))`, channel, key, strings.Repeat("a", 32), epochDigest)
	exec(`INSERT INTO protected_migration_recovery_epochs
		(channel_id,purpose,generation,key_id,epoch_digest,recovery_id,device_id,ciphertext,signature,confirmation)
		VALUES(?,'archive',1,?,?,?,?,zeroblob(80),zeroblob(64),zeroblob(64))`, channel, key, epochDigest, recoveryID, owner.Access.DeviceID)
	exec(`INSERT INTO protected_archive_links(channel_id,archive_generation,purpose,target_generation,target_key_id,ciphertext)
		VALUES(?,2,'archive',1,?,zeroblob(60))`, channel, key)

	const expired = "expired"
	const atBoundary = "at boundary"
	cutoff := now.Add(-365 * 24 * time.Hour)
	for _, entry := range []struct {
		cursor string
		at     time.Time
		reason string
	}{
		{strings.Repeat("b", 32), cutoff.Add(-time.Millisecond), expired},
		{strings.Repeat("c", 32), cutoff, atBoundary},
	} {
		exec(`INSERT INTO protected_audit_events(cursor,occurred_at,actor,action,kind,object_id,channel_id,category_id,position,reason,change)
			VALUES(?,?,?,'member.timeout','member',?,'','',0,?,CAST('{}' AS BLOB))`,
			entry.cursor, entry.at.UnixMilli(), owner.Access.EffectiveProfileID, owner.Access.EffectiveProfileID, entry.reason)
	}
	if err := store.PruneAudit(ctx); err != nil {
		t.Fatal(err)
	}
	remaining := func(reason string) int {
		t.Helper()
		var count int
		if err := server.db.QueryRowContext(ctx, "SELECT count(*) FROM protected_audit_events WHERE reason=?", reason).
			Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	if remaining(expired) != 0 || remaining(atBoundary) != 1 {
		t.Fatal("default retention did not respect the exact expiry boundary")
	}
	now = now.Add(time.Millisecond)
	if err := store.PruneAudit(ctx); err != nil {
		t.Fatal(err)
	}
	if remaining(atBoundary) != 0 {
		t.Fatal("expired boundary event still in the audit")
	}
	if after, err := access.ReadPolicyHead(ctx, server.db, nil); err != nil || after.Digest != proof.Digest {
		t.Fatalf("audit pruning changed the policy head: %+v %v", after, err)
	}
	var rows int
	err = server.db.QueryRowContext(ctx, `SELECT count(*) FROM protected_archive_links link
		JOIN protected_epochs epoch ON epoch.channel_id=link.channel_id AND epoch.key_id=link.target_key_id
		JOIN protected_migration_recovery_epochs current ON current.channel_id=epoch.channel_id
			AND current.key_id=epoch.key_id AND current.epoch_digest=epoch.digest
		JOIN protected_migration_recovery_packages imported ON imported.channel_id=current.channel_id
			AND imported.key_id=current.key_id AND imported.recovery_id=current.recovery_id
		JOIN protected_migration_owner_recovery owner ON owner.recovery_id=imported.recovery_id
		WHERE link.channel_id=? AND owner.profile_id=?`, channel, owner.Access.EffectiveProfileID).Scan(&rows)
	if err != nil || rows != 1 {
		t.Fatalf("audit pruning changed migration key data: %d %v", rows, err)
	}
}
