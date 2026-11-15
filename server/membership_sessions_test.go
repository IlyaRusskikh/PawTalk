package main

import (
	"context"
	"testing"
	"time"
)

func TestMembershipRepeatedRestartsEvictOldSessionsButPreserveVoice(t *testing.T) {
	s := testMembershipStore(t)
	clock := time.Now()
	s.now = func() time.Time { return clock }
	signer := newTestMemberSigner(1)
	owner := bootstrapTestServer(t, s, signer)
	ctx := context.Background()
	var channel string
	if err := s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='voice'").Scan(&channel); err != nil {
		t.Fatal(err)
	}
	if _, err := s.joinVoice(ctx, owner.Token, channel, config{APIKey: "synthetic", APISecret: "synthetic"}); err != nil {
		t.Fatal(err)
	}
	early := loginTestMember(t, s, signer)
	for index := 0; index < 20; index++ {
		clock = clock.Add(time.Millisecond)
		loginTestMember(t, s, signer)
	}
	if err := s.voiceHeartbeat(ctx, owner.Token); err != nil {
		t.Fatal("restart evicted the live voice owner", err)
	}
	if _, err := s.state(ctx, early.Token); err == nil {
		t.Fatal("old non-media session was never evicted")
	}
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at>?", clock.UnixMilli()).Scan(&count); err != nil || count != 16 {
		t.Fatal("active session budget", count, err)
	}
}
