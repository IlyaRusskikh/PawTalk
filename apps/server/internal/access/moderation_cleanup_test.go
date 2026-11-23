package access

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
)

func TestModerationCleanupRespectsWindowHistoryAndPollGrant(t *testing.T) {
	ctx := context.Background()
	db, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "cleanup.sqlite")))
	state := testPolicyState()
	state.Roles["reader"] = Role{Grants: []string{"message.delete-other"}}
	delete(state.Categories["private"].Roles, "reader")
	state.Admissions = map[string]map[string]Admission{"public": {"reader": {FirstPosition: 4}}}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	const now int64 = 8_000_000
	seed := func(channel string, position, sentAt int64) {
		t.Helper()
		operation := fmt.Sprintf("%s-%d", channel, position)
		exec(`INSERT INTO protected_message_receipts VALUES(?,?,'device','target',?, ?,?,zeroblob(12))`,
			channel, position, operation, operation, sentAt)
		exec(`INSERT INTO protected_messages VALUES(?,?,'device','target',?, ?,zeroblob(12),zeroblob(17),zeroblob(64))`,
			channel, position, operation, operation)
	}
	seed("secret", 8, now)
	seed("public", 3, now)
	seed("public", 4, now-3_600_001)
	seed("public", 5, now-3_600_000)
	seed("public", 6, now)
	seed("public", 7, now)
	exec(`INSERT INTO protected_polls VALUES('public',6,'target',?,?, '{}')`, now, now)
	exec(`INSERT INTO protected_poll_results VALUES('public',7,6,'{}')`)
	run := func(remove bool) (string, int64) {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		digest, count, err := walkModerationCleanup(ctx, tx, state, ModerationCleanupSources{}, Principal{ProfileID: "reader"},
			"target", now-3_600_000, now, now, remove)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return digest, count
	}
	digest, count := run(false)
	if count != 1 {
		t.Fatalf("preview included a hidden, old or dedicated message: %d", count)
	}
	if applied, removed := run(true); applied != digest || removed != count {
		t.Fatalf("cleanup differs from preview: %s, %d", applied, removed)
	}
	state.Roles["reader"] = Role{Grants: []string{"poll.delete-completed"}}
	if _, count := run(true); count != 2 {
		t.Fatalf("completed poll and its result should be removed together: %d", count)
	}
	var retained, removed int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM protected_messages").Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM protected_message_deletions WHERE channel_id='public' AND position IN (5,6,7)").Scan(&removed); err != nil {
		t.Fatal(err)
	}
	if retained != 3 || removed != 3 {
		t.Fatalf("retained = %d, removed in scope = %d", retained, removed)
	}
}
