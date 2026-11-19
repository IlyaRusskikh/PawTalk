package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestMembershipAttachmentOwnershipPaginationAndCascade(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	clock := time.Now()
	s.now = func() time.Time { return clock }
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	otherSigner := newTestMemberSigner(2)
	activateTestMember(t, s, otherSigner, "member")
	other := loginTestMember(t, s, otherSigner)
	var channel string
	if err := s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel); err != nil {
		t.Fatal(err)
	}
	second, err := s.createChannel(ctx, owner.Token, "text", "Second", strings.Repeat("1", 32))
	if err != nil {
		t.Fatal(err)
	}
	packet := memberInvitePackage{Version: 2, KeyID: strings.Repeat("a", 64), Nonce: b64.EncodeToString(make([]byte, 12)), Ciphertext: b64.EncodeToString(make([]byte, 32))}
	attachment := strings.Repeat("a", 32)
	if err = s.putAttachment(ctx, owner.Token, channel, attachment, packet); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.attachment(ctx, other.Token, channel, attachment); err == nil {
		t.Fatal("staged upload readable before message")
	}
	stolen := testMessage('b')
	stolen.AttachmentIDs = []string{attachment}
	if _, err = s.postMessage(ctx, other.Token, channel, stolen); err == nil {
		t.Fatal("another device claimed upload")
	}
	if _, err = s.postMessage(ctx, owner.Token, second, stolen); err == nil {
		t.Fatal("upload crossed channel")
	}
	first, err := s.postMessage(ctx, owner.Token, channel, stolen)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.attachment(ctx, other.Token, channel, attachment); err != nil {
		t.Fatal("published upload unreadable", err)
	}
	if _, _, err = s.attachment(ctx, other.Token, second, attachment); err == nil {
		t.Fatal("image fetched through wrong channel")
	}
	for index := 0; index < 9; index++ {
		clock = clock.Add(time.Second)
		message := testMessage('c')
		message.RequestID = fmt.Sprintf("%032x", index+100)
		if _, err = s.postMessage(ctx, owner.Token, channel, message); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.messagePage(ctx, other.Token, channel, 3, 0, 0, first)
	if err != nil || len(page.Messages) != 3 || !page.HasOlder || page.HasNewer || page.Unread != 9 {
		t.Fatal("latest page", page, err)
	}
	for index := 1; index < len(page.Messages); index++ {
		if page.Messages[index-1].ID >= page.Messages[index].ID {
			t.Fatal("page not chronological")
		}
	}
	older, err := s.messagePage(ctx, other.Token, channel, 3, page.Messages[0].ID, 0, 0)
	if err != nil || len(older.Messages) != 3 || !older.HasNewer || older.Messages[2].ID >= page.Messages[0].ID {
		t.Fatal("older page", older, err)
	}
	after, err := s.messagePage(ctx, other.Token, channel, 3, 0, older.Messages[2].ID, 0)
	if err != nil || len(after.Messages) != 3 || after.Messages[0].ID != page.Messages[0].ID {
		t.Fatal("after page", after, err)
	}
	ownPage, err := s.messagePage(ctx, owner.Token, channel, 3, 0, 0, 0)
	if err != nil || ownPage.Unread != 0 {
		t.Fatal("own messages unread", err)
	}
	if err = s.deleteMessage(ctx, owner.Token, first, strings.Repeat("e", 32)); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.attachment(ctx, other.Token, channel, attachment); err == nil {
		t.Fatal("deleted message retained readable image")
	}
	for index := 0; index < 20; index++ {
		if err = s.putAttachment(ctx, owner.Token, channel, fmt.Sprintf("%032x", index+300), packet); err != nil {
			t.Fatal(err)
		}
	}
	if err = s.putAttachment(ctx, owner.Token, channel, strings.Repeat("f", 32), packet); err == nil {
		t.Fatal("pending upload limit bypassed")
	}
	clock = clock.Add(1801 * time.Second)
	if err = s.putAttachment(ctx, owner.Token, channel, strings.Repeat("f", 32), packet); err != nil {
		t.Fatal("expired uploads blocked quota", err)
	}
	var pending int
	s.db.QueryRow("SELECT COUNT(*) FROM attachments WHERE message_id IS NULL").Scan(&pending)
	if pending != 1 {
		t.Fatal("staging cleanup", pending)
	}
}

func TestMembershipEditRemovesAttachmentOnlyForAuthor(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	signer := newTestMemberSigner(2)
	activateTestMember(t, s, signer, "member")
	other := loginTestMember(t, s, signer)
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	attachment := strings.Repeat("a", 32)
	packet := memberInvitePackage{Version: 2, KeyID: strings.Repeat("a", 64), Nonce: b64.EncodeToString(make([]byte, 12)), Ciphertext: b64.EncodeToString(make([]byte, 32))}
	if err := s.putAttachment(ctx, owner.Token, channel, attachment, packet); err != nil {
		t.Fatal(err)
	}
	input := testMessage('b')
	input.AttachmentIDs = []string{attachment}
	id, err := s.postMessage(ctx, owner.Token, channel, input)
	if err != nil {
		t.Fatal(err)
	}
	edit := testMessage('c')
	edit.RemoveAttachment = true
	if err = s.editMessage(ctx, other.Token, id, edit); err == nil {
		t.Fatal("non-author removed attachment")
	}
	if _, _, err = s.attachment(ctx, owner.Token, channel, attachment); err != nil {
		t.Fatal(err)
	}
	if err = s.editMessage(ctx, owner.Token, id, edit); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.attachment(ctx, owner.Token, channel, attachment); err == nil {
		t.Fatal("removed attachment readable")
	}
	page, err := s.messagePage(ctx, owner.Token, channel, 10, 0, 0, 0)
	if err != nil || len(page.Messages) != 1 || len(page.Messages[0].AttachmentIDs) != 0 {
		t.Fatal("message lost or attachment retained", err)
	}
}
