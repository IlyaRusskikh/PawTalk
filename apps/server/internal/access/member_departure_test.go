package access

import (
	"strings"
	"testing"
)

func TestTimedBanExpiryDoesNotRestoreMembership(t *testing.T) {
	owner, member := strings.Repeat("1", 64), strings.Repeat("2", 64)
	state := State{RoleSnapshot: RoleSnapshot{
		Policy: Policy{Owner: owner, Order: []string{"member"}, Roles: map[string]Role{Everyone: {}, "member": {}}},
		Members: map[string]Subject{
			owner:  {ID: owner, Active: true},
			member: {ID: member, Active: true, Roles: []string{"member"}},
		},
	}}
	ban := PolicyResourceChange{ID: member, Departure: &MemberPolicyDeparture{
		CutoverDigest: strings.Repeat("3", 64), Reason: "Synthetic ban", At: 1000, ExpiresAt: 2000,
	}}
	if err := state.applyMemberDeparture(Principal{ProfileID: owner}, BanPolicyMember, ban); err != nil {
		t.Fatal(err)
	}
	removal := state.MemberRemovals[member]
	if !removal.BannedAt(1999) || removal.BannedAt(2000) {
		t.Fatalf("incorrect expiry boundary: %+v", removal)
	}
	if result := state.Members[member]; result.Active || len(result.Roles) != 0 || result.ID != member {
		t.Fatalf("expiry restored the former membership: %+v", result)
	}
}
