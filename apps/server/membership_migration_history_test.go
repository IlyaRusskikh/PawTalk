package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProtectedMigrationHistoryResumesFrozenCiphertextAndLinks(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(10000, 0)
	path := filepath.Join(t.TempDir(), membershipDatabaseFile)
	store, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	first := bootstrapTestServer(t, store, newTestMemberSigner(1))
	second := activateTestMember(t, store, newTestMemberSigner(2), "member")
	var channel string
	if err := store.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_text'").Scan(&channel); err != nil {
		t.Fatal(err)
	}
	var deviceID string
	if err := store.db.QueryRow("SELECT device_id FROM devices WHERE original_profile_id=?", first.Access.ProfileID).Scan(&deviceID); err != nil {
		t.Fatal(err)
	}
	const original int64 = 9007199254740993
	const result int64 = original + 2
	const checklist int64 = original + 4
	key := strings.Repeat("a", 64)
	poll := strings.Repeat("a", 32)
	resultRequest := strings.Repeat("b", 32)
	attachment := strings.Repeat("c", 32)
	pending := strings.Repeat("d", 32)
	nonce := bytes.Repeat([]byte{0x41}, 12)
	ciphertext := bytes.Repeat([]byte{0xc1}, 17)
	resultCiphertext := bytes.Repeat([]byte{0xc2}, 19)
	insert := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, message := range []struct {
		id         int64
		requestID  string
		ciphertext []byte
	}{
		{original, poll, ciphertext},
		{result, resultRequest, resultCiphertext},
		{checklist, "checklist", ciphertext},
	} {
		insert(`INSERT INTO messages(message_id,channel_id,author_profile_id,author_device_id,request_id,sent_at,edited_at,crypto_context_id,nonce,ciphertext)
			VALUES(?,?,?,?,?,100,200,?,?,?)`, message.id, channel, first.Access.ProfileID, deviceID, message.requestID, key, nonce, message.ciphertext)
	}
	insert(`INSERT INTO attachments(attachment_id,channel_id,message_id,owner_device_id,crypto_context_id,nonce,ciphertext,created_at)
		VALUES(?,?,?,?,?,?,?,100),(?,?,NULL,?,?,?,?,100)`, attachment, channel, original, deviceID, key, nonce, ciphertext, pending, channel, deviceID, key, nonce, resultCiphertext)
	insert(`INSERT INTO polls(poll_id,message_id,option_count,multiple,anonymous,intermediate,closes_at,closed_at,
		result_message_id,result_request_id,result_nonce,result_ciphertext,create_hash)
		VALUES(?,?,2,1,1,0,300,500,?,?,?,?,?)`, poll, original, result, resultRequest, nonce, resultCiphertext, bytes.Repeat([]byte{1}, 32))
	insert(`INSERT INTO poll_votes(poll_id,profile_id,choices,updated_at) VALUES(?,?,'[0]',250),(?,?,'[1]',270)`,
		poll, first.Access.ProfileID, poll, second.ProfileID)
	insert(`INSERT INTO system_messages(message_id,kind) VALUES(?,'poll-result')`, result)
	insert(`INSERT INTO checklists(message_id,item_ids,checked,everyone) VALUES(?,'["item"]','{"item":true}',1)`, checklist)
	// These broken links still pass SQLite foreign-key checks.
	insert(`UPDATE attachments SET channel_id=(SELECT channel_id FROM channels WHERE protected_kind='default_voice') WHERE attachment_id=?`, attachment)
	if _, err := inspectProtectedMigration(ctx, path, now); err == nil || !strings.Contains(err.Error(), "inconsistent channel") {
		t.Fatalf("inspection missed an attachment linked across channels: %v", err)
	}
	insert(`UPDATE attachments SET channel_id=? WHERE attachment_id=?`, channel, attachment)
	insert(`UPDATE polls SET result_message_id=? WHERE poll_id=?`, checklist, poll)
	if _, err := inspectProtectedMigration(ctx, path, now); err == nil || !strings.Contains(err.Error(), "inconsistent provenance") {
		t.Fatalf("inspection missed a poll result pointing to another message: %v", err)
	}
	insert(`UPDATE polls SET result_message_id=? WHERE poll_id=?`, result, poll)

	backup := copyMigrationDatabase(t, path)
	read := func(archive, kind, cursor string, limit int) (migrationHistoryPage, error) {
		t.Helper()
		db, err := openMembershipReadOnly(path)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		return readProtectedMigrationHistory(ctx, tx, archive, kind, cursor, limit)
	}
	if _, err := read(backup.digest, "messages", "", 1); err == nil || !strings.Contains(err.Error(), "maintenance") {
		t.Fatalf("live API 2 source permitted a migration read: %v", err)
	}
	prepared, err := backup.prepare(ctx, path, now)
	if err != nil || prepared.Inventory["poll_votes"] != 2 || prepared.Inventory["published_attachments"] != 1 || prepared.Inventory["pending_attachments"] != 1 {
		t.Fatalf("incorrect frozen inventory: %+v, %v", prepared, err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := read(strings.Repeat("0", 64), "messages", "", 1); err == nil || !strings.Contains(err.Error(), "checkpoint changed") {
		t.Fatalf("cursor from another archive passed: %v", err)
	}
	for _, c := range []struct {
		kind, cursor string
		limit        int
	}{
		{"messages", "09007199254740993", 1},
		{"poll_votes", "", 1},
		{"attachments", "", 2},
		{"sessions", "", 1},
	} {
		if _, err := read(backup.digest, c.kind, c.cursor, c.limit); err == nil {
			t.Fatalf("invalid request was accepted: %+v", c)
		}
	}
	readAll := func(kind string) []migrationHistoryRecord {
		t.Helper()
		var records []migrationHistoryRecord
		var cursor string
		for range 5 {
			page, err := read(backup.digest, kind, cursor, 1)
			if err != nil {
				t.Fatal(err)
			}
			records = append(records, page.Records...)
			if page.Next == "" {
				return records
			}
			cursor = page.Next
		}
		t.Fatal("cursor failed to reach the end")
		return nil
	}
	assertRecord := func(record migrationHistoryRecord, expected map[string]any, expectedCiphertext []byte) {
		t.Helper()
		var metadata map[string]any
		if err := json.Unmarshal(record.Metadata, &metadata); err != nil {
			t.Fatal(err)
		}
		for key, value := range expected {
			actual, ok := metadata[key]
			if !ok || actual != value {
				t.Fatalf("invalid %s on %s: %s", key, record.ID, record.Metadata)
			}
		}
		if !bytes.Equal(record.Ciphertext, expectedCiphertext) || (expectedCiphertext != nil && !bytes.Equal(record.Nonce, nonce)) {
			t.Fatalf("ciphertext bytes changed for %s", record.ID)
		}
	}
	messages := readAll("messages")
	if len(messages) != 3 || messages[0].ID != "9007199254740993" || messages[1].ID != "9007199254740995" || messages[2].ID != "9007199254740997" {
		t.Fatalf("messages lost order, precision or records: %+v", messages)
	}
	assertRecord(messages[0], map[string]any{"messageId": "9007199254740993", "keyId": key, "channelId": channel, "editedAt": float64(200), "authorProfileId": first.Access.ProfileID}, ciphertext)
	attachments := readAll("attachments")
	if len(attachments) != 1 {
		t.Fatalf("unexpected contents in published attachment history: %+v", attachments)
	}
	assertRecord(attachments[0], map[string]any{"attachmentId": attachment, "messageId": "9007199254740993", "ownerDeviceId": deviceID}, ciphertext)
	polls := readAll("polls")
	checklists := readAll("checklists")
	system := readAll("system_messages")
	if len(polls) != 1 || len(checklists) != 1 || len(system) != 1 {
		t.Fatal("polls, checklists or system message records were lost")
	}
	assertRecord(polls[0], map[string]any{"pollId": poll, "messageId": "9007199254740993", "resultMessageId": "9007199254740995", "resultRequestId": resultRequest}, resultCiphertext)
	assertRecord(checklists[0], map[string]any{"messageId": "9007199254740997", "everyone": float64(1)}, nil)
	assertRecord(system[0], map[string]any{"messageId": "9007199254740995", "kind": "poll-result"}, nil)
}
