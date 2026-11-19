package main

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestGalleryAttachmentBindingAndReplay(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	var channel string
	if err := s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel); err != nil {
		t.Fatal(err)
	}
	packet := memberInvitePackage{Version: 2, KeyID: strings.Repeat("a", 64), Nonce: b64.EncodeToString(make([]byte, 12)), Ciphertext: b64.EncodeToString(bytes.Repeat([]byte{7}, 32))}
	msg := testMessage('c')
	for i := 1; i <= 20; i++ {
		id := fmt.Sprintf("%032x", i)
		if err := s.putAttachment(ctx, owner.Token, channel, id, packet); err != nil {
			t.Fatal(i, err)
		}
		msg.AttachmentIDs = append(msg.AttachmentIDs, id)
	}
	if err := s.putAttachment(ctx, owner.Token, channel, strings.Repeat("f", 32), packet); err == nil {
		t.Fatal("pending attachment count was unbounded")
	}
	invalid := msg
	invalid.AttachmentIDs = append([]string(nil), msg.AttachmentIDs...)
	invalid.AttachmentIDs[19] = strings.Repeat("f", 32)
	if _, err := s.postMessage(ctx, owner.Token, channel, invalid); err == nil {
		t.Fatal("bound a missing attachment")
	}
	var remaining int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM attachments WHERE message_id IS NULL").Scan(&remaining); err != nil || remaining != 20 {
		t.Fatal("failed binding was not atomic", remaining, err)
	}
	id, err := s.postMessage(ctx, owner.Token, channel, msg)
	if err != nil {
		t.Fatal(err)
	}
	reversed := msg
	reversed.AttachmentIDs = append([]string(nil), msg.AttachmentIDs...)
	for i, j := 0, len(reversed.AttachmentIDs)-1; i < j; i, j = i+1, j-1 {
		reversed.AttachmentIDs[i], reversed.AttachmentIDs[j] = reversed.AttachmentIDs[j], reversed.AttachmentIDs[i]
	}
	if retry, err := s.postMessage(ctx, owner.Token, channel, reversed); err != nil || retry != id {
		t.Fatal("same set retry failed", retry, err)
	}
	if _, err := s.postMessage(ctx, owner.Token, channel, invalid); err == nil {
		t.Fatal("same-length different set accepted on retry")
	}
	duplicate := msg
	duplicate.AttachmentIDs = []string{msg.AttachmentIDs[0], msg.AttachmentIDs[0]}
	if _, _, err := validateMessageInput(duplicate); err == nil {
		t.Fatal("duplicate attachment IDs accepted")
	}
	oversized := msg
	oversized.AttachmentIDs = append(append([]string(nil), msg.AttachmentIDs...), strings.Repeat("f", 32))
	if _, _, err := validateMessageInput(oversized); err == nil {
		t.Fatal("more than twenty encrypted references accepted")
	}
}

func TestAttachmentLimitExpansionPreservesBytesAndOwnership(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	var channel string
	if err := s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel); err != nil {
		t.Fatal(err)
	}
	start := strings.Index(membershipSchema, "CREATE TABLE attachments (")
	end := strings.Index(membershipSchema[start:], "CREATE TABLE invites") + start
	legacy := strings.ReplaceAll(membershipSchema[start:end], "52428816", "2097168")
	if _, err := s.db.Exec("DROP TABLE attachments;" + legacy); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("b", 32)
	small := bytes.Repeat([]byte{7}, 32)
	packet := memberInvitePackage{Version: 2, KeyID: strings.Repeat("a", 64), Nonce: b64.EncodeToString(make([]byte, 12)), Ciphertext: b64.EncodeToString(small)}
	if err := s.putAttachment(ctx, owner.Token, channel, id, packet); err != nil {
		t.Fatal(err)
	}
	msg := testMessage('c')
	msg.AttachmentIDs = []string{id}
	if _, err := s.postMessage(ctx, owner.Token, channel, msg); err != nil {
		t.Fatal(err)
	}
	if err := s.expandAttachmentStorage(); err != nil {
		t.Fatal(err)
	}
	if err := s.expandAttachmentStorage(); err != nil {
		t.Fatal("migration not idempotent", err)
	}
	got, _, err := s.attachment(ctx, owner.Token, channel, id)
	if err != nil || got.Ciphertext != packet.Ciphertext {
		t.Fatal("migration lost encrypted bytes", err)
	}
	packet.Ciphertext = b64.EncodeToString(bytes.Repeat([]byte{8}, 3*1024*1024))
	if err = s.putAttachment(ctx, owner.Token, channel, strings.Repeat("d", 32), packet); err != nil {
		t.Fatal("expanded upload failed", err)
	}
	if _, err = s.db.Exec("UPDATE attachments SET owner_device_id='missing' WHERE attachment_id=?", id); err == nil {
		t.Fatal("migration lost foreign keys")
	}
	if _, err = s.db.Exec("UPDATE attachments SET message_id=999 WHERE attachment_id=?", id); err == nil {
		t.Fatal("migration lost ownership trigger")
	}
}
