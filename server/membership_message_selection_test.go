package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestMembershipMessageSelection(t *testing.T) {
	s := testMembershipStore(t)
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	ctx := context.Background()
	clock := s.now()
	s.now = func() time.Time { return clock }
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	other, err := s.createChannel(ctx, admin.Token, "text", "Other", strings.Repeat("e", 32))
	if err != nil {
		t.Fatal(err)
	}
	ids := []int64{}
	for i := 0; i < 12; i++ {
		clock = clock.Add(time.Second)
		input := testMessage('a')
		input.RequestID = fmt.Sprintf("%032x", i+1)
		id, err := s.postMessage(ctx, admin.Token, channel, input)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	clock = clock.Add(time.Second)
	foreignInput := testMessage('b')
	foreignInput.RequestID = strings.Repeat("f", 32)
	foreign, err := s.postMessage(ctx, admin.Token, other, foreignInput)
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.messagePage(ctx, admin.Token, channel, 5, 0, 0, 0, memberMessageSelection{Around: ids[5]})
	if err != nil || len(page.Messages) != 5 || page.Messages[0].ID != ids[3] || page.Messages[2].ID != ids[5] {
		t.Fatal("around", err, page)
	}
	page, err = s.messagePage(ctx, admin.Token, channel, 1, 0, 0, 0, memberMessageSelection{IDs: []int64{ids[0], ids[10], foreign}})
	if err != nil || len(page.Messages) != 2 {
		t.Fatal("scoped lookup", err, page)
	}
	edit := testMessage('c')
	edit.RequestID = strings.Repeat("d", 32)
	if err = s.editMessage(ctx, admin.Token, ids[0], edit); err != nil {
		t.Fatal(err)
	}
	page, err = s.messagePage(ctx, admin.Token, channel, 5, 0, 0, 0, memberMessageSelection{IDs: []int64{ids[0]}})
	if err != nil || page.Messages[0].EditedAt == nil {
		t.Fatal("fresh edited source", err)
	}
	if err = s.deleteMessage(ctx, admin.Token, ids[0], strings.Repeat("c", 32)); err != nil {
		t.Fatal(err)
	}
	page, err = s.messagePage(ctx, admin.Token, channel, 5, 0, 0, 0, memberMessageSelection{IDs: []int64{ids[0]}})
	if err != nil || len(page.Messages) != 0 {
		t.Fatal("deleted source", err)
	}
	if _, err = s.messagePage(ctx, "invalid", channel, 5, 0, 0, 0, memberMessageSelection{IDs: ids}); err == nil {
		t.Fatal("anonymous lookup")
	}
	for _, selection := range []memberMessageSelection{{Around: -1}, {IDs: []int64{0}}, {Around: 1, IDs: ids}, {IDs: make([]int64, 501)}} {
		if _, err = s.messagePage(ctx, admin.Token, channel, 5, 0, 0, 0, selection); err == nil {
			t.Fatal("invalid selection accepted")
		}
	}
}
