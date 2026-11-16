package main

import (
	"context"
	"encoding/hex"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newPollMessage(n byte, anonymous, intermediate, multiple bool) memberMessageInput {
	input := testMessage(n)
	result := testMessage(n + 1)
	input.Poll = &memberPollCreate{OptionCount: 3, Duration: 3600, Anonymous: anonymous, Intermediate: intermediate, Multiple: multiple, Result: result}
	return input
}
func TestPollVotingPrivacyAndOfflineCompletion(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	clock := s.now()
	s.now = func() time.Time { return clock }
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	signer := newTestMemberSigner(2)
	activateTestMember(t, s, signer, "member")
	other := loginTestMember(t, s, signer)
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	input := newPollMessage('a', true, false, false)
	id, err := s.postMessage(ctx, owner.Token, channel, input)
	if err != nil {
		t.Fatal(err)
	}
	if retry, err := s.postMessage(ctx, owner.Token, channel, input); err != nil || retry != id {
		t.Fatal("creation retry", err)
	}
	altered := *input.Poll
	altered.Anonymous = false
	changed := input
	changed.Poll = &altered
	if _, err = s.postMessage(ctx, owner.Token, channel, changed); err == nil {
		t.Fatal("retry changed settings")
	}
	rid := func(n byte) string { return strings.Repeat(hex.EncodeToString([]byte{n}), 16) }
	for _, choices := range [][]int{{-1}, {3}, {0, 0}, {0, 1}} {
		if err = s.votePoll(ctx, other.Token, input.RequestID, rid(1), choices); err == nil {
			t.Fatal("invalid vote accepted", choices)
		}
	}
	if err = s.votePoll(ctx, other.Token, input.RequestID, rid(2), []int{1}); err != nil {
		t.Fatal(err)
	}
	state, err := s.pollState(ctx, owner.Token, input.RequestID)
	if err != nil || state.Total != 1 || len(state.Counts) != 0 || len(state.Voters) != 0 || len(state.Own) != 0 {
		t.Fatal("hidden results leaked", state, err)
	}
	if err = s.votePoll(ctx, other.Token, input.RequestID, rid(3), []int{2}); err != nil {
		t.Fatal(err)
	}
	state, err = s.pollState(ctx, other.Token, input.RequestID)
	if err != nil || len(state.Own) != 1 || state.Own[0] != 2 || state.Total != 1 {
		t.Fatal("vote change", state, err)
	}
	if err = s.votePoll(ctx, other.Token, input.RequestID, rid(4), []int{}); err != nil {
		t.Fatal(err)
	}
	if err = s.votePoll(ctx, other.Token, input.RequestID, rid(5), []int{0}); err != nil {
		t.Fatal(err)
	}
	if err = s.closePoll(ctx, other.Token, input.RequestID, rid(6)); err == nil {
		t.Fatal("non-author closed poll")
	}
	edit := testMessage('c')
	if err = s.editMessage(ctx, owner.Token, id, edit); err == nil {
		t.Fatal("edited published poll")
	}
	reserved := testMessage('b')
	if _, err = s.postMessage(ctx, owner.Token, channel, reserved); err == nil {
		t.Fatal("result request id not reserved")
	}
	clock = clock.Add(time.Hour + time.Second)
	if err = s.closeExpiredPolls(ctx); err != nil {
		t.Fatal(err)
	}
	if err = s.closeExpiredPolls(ctx); err != nil {
		t.Fatal(err)
	}
	// Expiry is independent of owner membership/session and publishes the saved bytes once.
	state, err = s.pollState(ctx, other.Token, input.RequestID)
	if err != nil || state.ClosedAt == nil || len(state.Counts) != 3 || state.Counts[0] != 1 || len(state.Voters) != 0 {
		t.Fatal("final anonymous result", state, err)
	}
	var count int
	s.db.QueryRow("SELECT COUNT(*) FROM messages WHERE channel_id=?", channel).Scan(&count)
	if count != 2 {
		t.Fatal("missing or duplicate result", count)
	}
	var cipher []byte
	s.db.QueryRow("SELECT ciphertext FROM messages WHERE request_id=?", input.Poll.Result.RequestID).Scan(&cipher)
	if b64.EncodeToString(cipher) != input.Poll.Result.Ciphertext {
		t.Fatal("server changed encrypted result")
	}
	if err = s.votePoll(ctx, other.Token, input.RequestID, rid(7), []int{1}); err == nil {
		t.Fatal("late vote accepted")
	}
}
func TestPollPublicMultipleResultsEarlyCloseAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "polls.sqlite")
	s, err := openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.db.Close() }()
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	input := newPollMessage('c', false, true, true)
	if _, err = s.postMessage(ctx, owner.Token, channel, input); err != nil {
		t.Fatal(err)
	}
	if err = s.votePoll(ctx, owner.Token, input.RequestID, strings.Repeat("e", 32), []int{0, 2}); err != nil {
		t.Fatal(err)
	}
	state, err := s.pollState(ctx, owner.Token, input.RequestID)
	if err != nil || state.Total != 1 || state.Counts[0] != 1 || state.Counts[2] != 1 || len(state.Voters[0]) != 1 {
		t.Fatal("public multiple results", state, err)
	}
	s.db.Close()
	s, err = openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.closePoll(ctx, owner.Token, input.RequestID, strings.Repeat("f", 32)); err != nil {
		t.Fatal(err)
	}
	state, err = s.pollState(ctx, owner.Token, input.RequestID)
	if err != nil || state.ClosedAt == nil || state.Total != 1 {
		t.Fatal("restart / early completion", state, err)
	}
	if err = s.closePoll(ctx, owner.Token, input.RequestID, strings.Repeat("f", 32)); err != nil {
		t.Fatal("early-close retry", err)
	}
	if _, err = s.pollState(ctx, "invalid", input.RequestID); err == nil {
		t.Fatal("unauthenticated results")
	}
}
