package main

import (
	"context"
	"strings"
	"testing"
)

func TestMembershipChannelOrderAtomic(t *testing.T) {
	s := testMembershipStore(t)
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	ctx := context.Background()
	member := newTestMemberSigner(2)
	activateTestMember(t, s, member, "member")
	ms := loginTestMember(t, s, member)
	var first, voice string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&first)
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='voice'").Scan(&voice)
	second, err := s.createChannel(ctx, admin.Token, "text", "Second", strings.Repeat("1", 32))
	if err != nil {
		t.Fatal(err)
	}
	items := []channelOrderItem{{second, 1}, {first, 1}}
	if err = s.reorderChannels(ctx, ms.Token, "text", strings.Repeat("2", 32), items); err == nil {
		t.Fatal("member reordered")
	}
	if err = s.reorderChannels(ctx, admin.Token, "text", strings.Repeat("3", 32), items); err != nil {
		t.Fatal(err)
	}
	if err = s.reorderChannels(ctx, admin.Token, "text", strings.Repeat("3", 32), items); err != nil {
		t.Fatal("retry", err)
	}
	var top string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text' ORDER BY position").Scan(&top)
	if top != second {
		t.Fatal("order not stored")
	}
	for i, bad := range [][]channelOrderItem{{{first, 2}}, {{first, 2}, {first, 2}}, {{first, 2}, {voice, 1}}, {{first, 2}, {second, 1}}} {
		if err = s.reorderChannels(ctx, admin.Token, "text", strings.Repeat(string(rune('4'+i)), 32), bad); err == nil {
			t.Fatal("accepted invalid/stale order", i)
		}
		var pos int
		var revision int64
		s.db.QueryRow("SELECT position,revision FROM channels WHERE channel_id=?", first).Scan(&pos, &revision)
		if pos != 1 || revision != 2 {
			t.Fatal("partial reorder", i, pos, revision)
		}
	}
}
