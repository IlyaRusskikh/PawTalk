package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func testMessage(n byte) memberMessageInput {
	return memberMessageInput{RequestID: strings.Repeat(string(n), 32), KeyID: strings.Repeat("a", 64), Nonce: b64.EncodeToString(bytes.Repeat([]byte{n}, 12)), Ciphertext: b64.EncodeToString(bytes.Repeat([]byte{n}, 32)), AttachmentIDs: []string{}}
}

func TestMembershipChannelsAndMessageIsolation(t *testing.T) {
	s := testMembershipStore(t)
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	member := newTestMemberSigner(2)
	activateTestMember(t, s, member, "member")
	ms := loginTestMember(t, s, member)
	ctx := context.Background()
	var general, voice string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_text'").Scan(&general)
	s.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_voice'").Scan(&voice)
	if _, err := s.createChannel(ctx, ms.Token, "text", "Forbidden", strings.Repeat("1", 32)); err == nil {
		t.Fatal("member created channel")
	}
	other, err := s.createChannel(ctx, admin.Token, "text", "Other", strings.Repeat("2", 32))
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := s.createChannel(ctx, admin.Token, "text", "Other", strings.Repeat("2", 32))
	if err != nil || repeated != other {
		t.Fatal("channel retry not idempotent", err)
	}
	if err = s.deleteChannel(ctx, admin.Token, general, strings.Repeat("3", 32)); err == nil {
		t.Fatal("deleted protected general")
	}
	id, err := s.postMessage(ctx, ms.Token, general, testMessage('a'))
	if err != nil {
		t.Fatal(err)
	}
	repeatedID, err := s.postMessage(ctx, ms.Token, general, testMessage('a'))
	if err != nil || repeatedID != id {
		t.Fatal("message retry not idempotent", err)
	}
	if _, err = s.postMessage(ctx, ms.Token, other, testMessage('a')); err == nil {
		t.Fatal("request reused in another channel")
	}
	if _, err = s.postMessage(ctx, ms.Token, voice, testMessage('b')); err == nil {
		t.Fatal("message posted to voice")
	}
	page, err := s.messagePage(ctx, ms.Token, other, 100, 0, 0, 0)
	if err != nil || len(page.Messages) != 0 {
		t.Fatal("history crossed channels", err)
	}
	if _, err = s.postMessage(ctx, ms.Token, other, testMessage('b')); err != nil {
		t.Fatal(err)
	}
	if err = s.deleteChannel(ctx, admin.Token, other, strings.Repeat("4", 32)); err != nil {
		t.Fatal(err)
	}
	page, err = s.messagePage(ctx, ms.Token, general, 100, 0, 0, 0)
	if err != nil || len(page.Messages) != 1 || page.Messages[0].ID != id {
		t.Fatal("channel deletion damaged other history", err)
	}
	var members int
	s.db.QueryRow("SELECT COUNT(*) FROM memberships").Scan(&members)
	if members != 2 {
		t.Fatal("history cleanup removed membership")
	}
}

func TestMembershipVoiceSingleSlotAndExpiry(t *testing.T) {
	s := testMembershipStore(t)
	clock := s.now()
	s.now = func() time.Time { return clock }
	main := newTestMemberSigner(1)
	admin := bootstrapTestServer(t, s, main)
	id := admin.Access
	second := loginTestMember(t, s, main)
	var voice string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_voice'").Scan(&voice)
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("s", 32), LivekitURL: "wss://127.0.0.1/rtc"}
	grant, err := s.joinVoice(context.Background(), admin.Token, voice, cfg)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(grant.Token, ".")
	payload, _ := b64.DecodeString(parts[1])
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		t.Fatal("invalid grant")
	}
	video := claims["video"].(map[string]any)
	attributes := claims["attributes"].(map[string]any)
	if video["room"] != grant.Room || video["roomAdmin"] != nil || attributes["pawtalk.profile"] != id.ProfileID || !grant.E2EERequired {
		t.Fatal("voice grant scope incorrect")
	}
	if _, err = s.joinVoice(context.Background(), second.Token, voice, cfg); err == nil {
		t.Fatal("second voice slot allowed")
	}
	clock = clock.Add(46 * time.Second)
	if err = s.voiceHeartbeat(context.Background(), admin.Token); err == nil {
		t.Fatal("expired slot revived by heartbeat")
	}
	if _, err = s.joinVoice(context.Background(), second.Token, voice, cfg); err != nil {
		t.Fatal("stale slot blocked new device", err)
	}
}

func TestMembershipStorageFailureRollsBackHistory(t *testing.T) {
	s := testMembershipStore(t)
	session := bootstrapTestServer(t, s, newTestMemberSigner(1))
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_text'").Scan(&channel)
	if _, err := s.postMessage(context.Background(), session.Token, channel, testMessage('a')); err != nil {
		t.Fatal(err)
	}
	s.maxBytes = 1
	if _, err := s.postMessage(context.Background(), session.Token, channel, testMessage('b')); err == nil {
		t.Fatal("impossible storage budget accepted")
	}
	var count int
	s.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&count)
	if count != 1 {
		t.Fatal("failed cleanup destroyed retained history")
	}
}
