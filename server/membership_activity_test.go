package main

import (
	"context"
	"testing"
	"time"
)

func TestActivityUsesAllLiveSessions(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	signer := newTestMemberSigner(1)
	one := bootstrapTestServer(t, s, signer)
	two := loginTestMember(t, s, signer)
	check := func(online, away bool) {
		t.Helper()
		state, err := s.state(ctx, one.Token)
		if err != nil {
			t.Fatal(err)
		}
		if len(state.Members) != 1 || state.Members[0].Online != online || state.Members[0].Away != away {
			t.Fatalf("unexpected presence: %+v", state.Members)
		}
	}
	if err := s.setActivity(ctx, one.Token, true); err != nil {
		t.Fatal(err)
	}
	check(true, false)
	if err := s.setActivity(ctx, two.Token, true); err != nil {
		t.Fatal(err)
	}
	check(true, true)
	if err := s.setActivity(ctx, two.Token, false); err != nil {
		t.Fatal(err)
	}
	check(true, false)
	if err := s.setActivity(ctx, "invalid", false); err == nil {
		t.Fatal("invalid session changed activity")
	}
	clock := s.now()
	s.now = func() time.Time { return clock.Add(46 * time.Second) }
	check(false, true)
}
