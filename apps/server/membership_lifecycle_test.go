package main

import (
	"context"
	"strings"
	"testing"
)

func TestMembershipLastAdministratorAndRoleMutations(t *testing.T) {
	s := testMembershipStore(t)
	a, b := newTestMemberSigner(1), newTestMemberSigner(2)
	ai := activateTestMember(t, s, a, "admin")
	bi := activateTestMember(t, s, b, "member")
	as, bs := loginTestMember(t, s, a), loginTestMember(t, s, b)
	ctx := context.Background()
	if err := s.changeRole(ctx, bs.Token, bi.ProfileID, "admin", strings.Repeat("1", 32)); err == nil {
		t.Fatal("member promoted itself")
	}
	if err := s.leave(ctx, as.Token, strings.Repeat("2", 32)); err == nil {
		t.Fatal("last administrator left")
	}
	if err := s.changeRole(ctx, as.Token, ai.ProfileID, "member", strings.Repeat("3", 32)); err == nil {
		t.Fatal("last administrator demoted")
	}
	if err := s.changeRole(ctx, as.Token, bi.ProfileID, "admin", strings.Repeat("4", 32)); err != nil {
		t.Fatal(err)
	}
	if err := s.changeRole(ctx, as.Token, bi.ProfileID, "admin", strings.Repeat("4", 32)); err != nil {
		t.Fatal("identical retry failed", err)
	}
	if err := s.changeRole(ctx, as.Token, bi.ProfileID, "member", strings.Repeat("4", 32)); err == nil {
		t.Fatal("request reused for different operation")
	}
	state, err := s.state(ctx, bs.Token)
	if err != nil || !state.Self.allows("role.manage") {
		t.Fatal("live session missed promotion", err)
	}
	if err = s.leave(ctx, as.Token, strings.Repeat("5", 32)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.state(ctx, as.Token); err == nil {
		t.Fatal("departed administrator retained access")
	}
	var role string
	if err = s.db.QueryRow("SELECT role_id FROM profile_roles WHERE profile_id=?", ai.ProfileID).Scan(&role); err != nil || role != "admin" {
		t.Fatal("leave discarded role", err)
	}
}
