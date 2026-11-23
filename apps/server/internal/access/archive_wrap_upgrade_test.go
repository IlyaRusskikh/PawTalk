package access

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestLegacyArchiveHeadsQueueAnUpgradeWithoutChangingProofs(t *testing.T) {
	ctx := context.Background()
	db, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "archive-upgrade.sqlite")))
	if err := store.Initialize(ctx, testPolicyState()); err != nil {
		t.Fatal(err)
	}
	state, revision, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	record := EpochRecord{ChannelID: "public", Purpose: ArchiveEpoch, Generation: 1, KeyID: strings.Repeat("1", 64),
		Signature: bytes.Repeat([]byte{2}, 64), TaskID: strings.Repeat("3", 32)}
	raw, err := json.Marshal(EpochProof{Record: record})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(record.Signature)
	if _, err := db.ExecContext(ctx, `INSERT INTO protected_epochs(channel_id,purpose,generation,key_id,task_id,digest,record)
		VALUES(?,?,?,?,?,?,?)`, record.ChannelID, record.Purpose, record.Generation, record.KeyID, record.TaskID, hex.EncodeToString(digest[:]), raw); err != nil {
		t.Fatal(err)
	}
	state.ArchiveHeads = map[string]uint64{"public": 1}
	snapshot, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE protected_policy SET snapshot=? WHERE id=1", snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM protected_rotation_tasks WHERE channel_id='public'"); err != nil {
		t.Fatal(err)
	}
	var previousTask string
	for range 2 {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		now := store.now().UnixMilli()
		if err := QueueArchiveWrapUpgrades(ctx, tx, now); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		var task string
		var taskRevision, priority int64
		if err := db.QueryRowContext(ctx, `SELECT task_id,revision,priority_until FROM protected_rotation_tasks
			WHERE channel_id='public' AND purpose='archive'`).Scan(&task, &taskRevision, &priority); err != nil {
			t.Fatal(err)
		}
		if !validRotationID(task) || taskRevision != revision || priority > now || previousTask != "" && previousTask != task {
			t.Fatalf("unexpected upgrade task: %s %d %d", task, taskRevision, priority)
		}
		previousTask = task
	}
	var after []byte
	if err := db.QueryRow("SELECT record FROM protected_epochs WHERE channel_id='public'").Scan(&after); err != nil || !bytes.Equal(raw, after) {
		t.Fatalf("archive format upgrade changed signed bytes: %v", err)
	}
}
