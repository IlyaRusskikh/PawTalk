package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

// The native migration fixture calls this on its isolated post-cutover copy
// before replacing the owner device and decrypting the original history.
func exerciseMigratedQuotaAndAuditRetention(t *testing.T, ctx context.Context, runtime *protectedRuntime,
	owner access.Principal, ownerKey ed25519.PrivateKey, channel, liveKey string) {
	t.Helper()
	server := runtime.store
	resolve := func(context.Context, access.SessionQuery) (access.Principal, error) { return owner, nil }
	used := func() int64 {
		t.Helper()
		tx, err := server.db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		size, err := memberStorageUsed(ctx, tx)
		if err != nil {
			t.Fatal(err)
		}
		return size
	}
	readCount := func(query string, args ...any) int {
		t.Helper()
		var count int
		if err := server.db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	appendMessage := func(operation string, attachments []access.MessageAttachment) access.MessageReceipt {
		t.Helper()
		attempt := access.MessageAttempt{ChannelID: channel, KeyID: liveKey, OperationID: operation,
			Nonce: bytes.Repeat([]byte{operation[0]}, 12), Ciphertext: make([]byte, 17), Attachments: attachments}
		frame, err := protectedMessageFrame(runtime.serverID, owner, attempt)
		if err != nil {
			t.Fatal(err)
		}
		attempt.Signature = ed25519.Sign(ownerKey, frame)
		receipt, err := runtime.protectedContentStore().AppendMessage(ctx, resolve, verifyProtectedMessageAttempt, attempt, true)
		if err != nil {
			t.Fatal(err)
		}
		return receipt
	}
	const frozenRecords = "SELECT count(*) FROM protected_migration_records WHERE channel_id=?"
	before := readCount(frozenRecords, channel)
	if before == 0 {
		t.Fatal("retention fixture needs imported ciphertext")
	}
	attachment := access.MessageAttachment{ID: strings.Repeat("b", 32), Kind: "file"}
	if err := runtime.protectedContentStore().PutAttachmentBlock(ctx, resolve, channel, attachment,
		access.AttachmentBlock{Total: access.AttachmentBlockSize, Bytes: make([]byte, access.AttachmentBlockSize)}, nil); err != nil {
		t.Fatal(err)
	}
	victim := appendMessage(strings.Repeat("c", 32), []access.MessageAttachment{attachment})
	originalLimit := server.maxBytes
	defer func() { server.maxBytes = originalLimit }()
	server.maxBytes = used() - 64*1024
	fresh := appendMessage(strings.Repeat("d", 32), nil)
	size := used()
	victims := readCount("SELECT count(*) FROM protected_messages WHERE channel_id=? AND position=?", channel, victim.Position)
	blocks := readCount("SELECT count(*) FROM protected_attachment_blocks WHERE id=?", attachment.ID)
	frozen := readCount(frozenRecords, channel)
	if size > server.maxBytes || fresh.Position != victim.Position+1 || victims != 0 || blocks != 0 || frozen != before {
		t.Fatalf("quota retained mutable content or changed frozen history: bytes %d/%d, positions %d->%d, victims %d, blocks %d, imported %d->%d",
			size, server.maxBytes, victim.Position, fresh.Position, victims, blocks, before, frozen)
	}
	server.maxBytes = originalLimit
	// Leave only the imported rows for the subsequent real client read.
	if err := runtime.protectedContentStore().DeleteMessage(ctx, resolve, nil, channel, fresh.Position); err != nil {
		t.Fatal(err)
	}

	cursor := strings.Repeat("e", 32)
	at := server.now().Add(-366 * 24 * time.Hour).UnixMilli()
	if _, err := server.db.ExecContext(ctx, `INSERT INTO protected_audit_events
		(cursor,occurred_at,actor,action,kind,object_id,channel_id,category_id,position,reason,change)
		VALUES(?,?,?,'member.timeout','member',?,'','',0,'expired quota fixture',CAST('{}' AS BLOB))`, cursor, at, owner.ProfileID, owner.ProfileID); err != nil {
		t.Fatal(err)
	}
	if err := runtime.protectedContentStore().PruneAudit(ctx); err != nil {
		t.Fatal(err)
	}
	if readCount("SELECT count(*) FROM protected_audit_events WHERE cursor=?", cursor) != 0 || readCount(frozenRecords, channel) != before {
		t.Fatal("audit retention failed to remove only the expired event")
	}
}
