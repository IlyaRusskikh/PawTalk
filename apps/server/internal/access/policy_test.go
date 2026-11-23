package access

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

func TestExplicitAdministratorChannelView(t *testing.T) {
	actor := Subject{ID: "actor", Active: true, Roles: []string{"admin"}}
	peer := Subject{ID: "peer", Active: true, Roles: []string{"admin"}}
	higher := Subject{ID: "higher", Active: true, Roles: []string{"higher"}}
	state := State{RoleSnapshot: RoleSnapshot{
		Policy: Policy{Owner: "owner", Order: []string{"admin", "higher"}, Roles: map[string]Role{
			"admin": {Grants: []string{Administrator}}, "higher": {},
		}},
		Members: map[string]Subject{actor.ID: actor, peer.ID: peer, higher.ID: higher},
	}}
	roles := map[string]Overwrite{Everyone: {Deny: []string{ChannelView}}}
	before := Scope{Kind: "text", Local: &ACL{Roles: roles}}
	withRule := func(id string, rule Overwrite) Scope {
		return Scope{Kind: "text", Local: &ACL{Roles: roles, Profiles: map[string]Overwrite{id: rule}}}
	}
	for _, member := range []Subject{actor, peer} {
		explicit := withRule(member.ID, Overwrite{Allow: []string{ChannelView}})
		if state.checkACLChange(actor, before, explicit, false) != HierarchyDenied {
			t.Fatal("unrelated transitions must enforce the old hierarchy")
		}
		if err := state.checkACLChange(actor, before, explicit, true); err != nil {
			t.Fatal(err)
		}
		if err := state.checkACLChange(actor, explicit, before, true); err != nil {
			t.Fatal(err)
		}
		if state.CheckGrant(member, before, ChannelView, 0) != Allowed || state.CheckGrant(member, explicit, ChannelView, 0) != Allowed {
			t.Fatal("an administrator must be able to view the channel with or without an explicit entry")
		}
	}
	for _, attempt := range []Scope{
		withRule(peer.ID, Overwrite{Allow: []string{"message.send"}}),
		withRule(peer.ID, Overwrite{Deny: []string{ChannelView}}),
		withRule(higher.ID, Overwrite{Allow: []string{ChannelView}}),
	} {
		if state.checkACLChange(actor, before, attempt, true) != HierarchyDenied {
			t.Fatal("the explicit administrator list widened other privileges")
		}
	}
}

func TestPolicy(t *testing.T) {
	var fixture struct {
		Policy   Policy
		Subjects map[string]Subject
		Scopes   map[string]Scope
		Cases    []struct {
			Name, Actor, Target, Scope, Permission string
			Lift                                   bool
			Want                                   Decision
		}
	}
	data, err := os.ReadFile("testdata/decisions.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, tt := range fixture.Cases {
		t.Run(tt.Name, func(t *testing.T) {
			actor := fixture.Subjects[tt.Actor]
			for i := 0; i < 2; i++ {
				got := fixture.Policy.CheckAction(actor, fixture.Subjects[tt.Target], fixture.Scopes[tt.Scope], tt.Permission, tt.Lift, 1)
				if got != tt.Want {
					t.Fatalf("decision = %s, want %s", got, tt.Want)
				}
				actor.Roles = slices.Clone(actor.Roles)
				slices.Reverse(actor.Roles)
			}
		})
	}
}

func TestRoleChange(t *testing.T) {
	snapshot := func() RoleSnapshot {
		return RoleSnapshot{
			Policy: Policy{
				Owner: "owner",
				Order: []string{"low", "staff"},
				Roles: map[string]Role{
					Everyone: {DefaultGrants()},
					"low":    {[]string{"message.pin"}},
					"staff":  {[]string{"role.edit", "role.assign", "message.pin"}},
				},
			},
			Members: map[string]Subject{
				"owner":  {ID: "owner", Active: true},
				"actor":  {ID: "actor", Roles: []string{"staff"}, Active: true},
				"peer":   {ID: "peer", Roles: []string{"staff", "low"}, Active: true},
				"target": {ID: "target", Active: true},
			},
		}
	}
	t.Run("assign lower role to lower participant", func(t *testing.T) {
		before, after := snapshot(), snapshot()
		after.Members["target"] = Subject{ID: "target", Roles: []string{"low"}, Active: true}
		if got := CheckRoleChange(before, after, "actor", nil, nil); got.Decision != Allowed {
			t.Fatal(got)
		}
	})
	t.Run("role assignment does not imply definitions or ACL editing", func(t *testing.T) {
		before, after := snapshot(), snapshot()
		before.Roles["staff"] = Role{[]string{"role.assign", "message.pin"}}
		after.Roles["staff"] = before.Roles["staff"]
		after.Roles["low"] = Role{}
		after.Members["peer"] = Subject{ID: "peer", Roles: []string{"staff"}, Active: true}
		before.Members["peer"] = after.Members["peer"]
		if got := CheckRoleChange(before, after, "actor", nil, nil); got.Decision != MissingGrant {
			t.Fatal(got)
		}
		if got := before.CheckAction(before.Members["actor"], before.Members["target"], Scope{Kind: "text"}, "channel.access.edit", false, 0); got != MissingGrant {
			t.Fatal(got)
		}
	})
	t.Run("presentation changes use role edit and hierarchy", func(t *testing.T) {
		before, after := snapshot(), snapshot()
		after.RolePresentation = map[string]RolePresentation{"low": {Name: "Helpers", Color: "#5a89bc", Icon: "🐾"}}
		if got := CheckRoleChange(before, after, "actor", nil, nil); got.Decision != Allowed {
			t.Fatal(got)
		}
		before.Roles["staff"] = Role{[]string{"role.assign"}}
		after.Roles["staff"] = before.Roles["staff"]
		if got := CheckRoleChange(before, after, "actor", nil, nil); got.Decision != MissingGrant {
			t.Fatal(got)
		}
		before = snapshot()
		after = snapshot()
		after.RolePresentation = map[string]RolePresentation{"staff": {Name: "Staff"}}
		if got := CheckRoleChange(before, after, "actor", nil, nil); got.Decision != HierarchyDenied {
			t.Fatal(got)
		}
		after.RolePresentation["staff"] = RolePresentation{Name: "Staff", Color: "#bad"}
		if got := CheckRoleChange(before, after, "owner", nil, nil); got.Decision != InvalidPolicy {
			t.Fatal(got)
		}
	})
	t.Run("administrator can change only the style of their highest role", func(t *testing.T) {
		before, after := snapshot(), snapshot()
		before.Roles["staff"] = Role{[]string{Administrator}}
		after.Roles["staff"] = before.Roles["staff"]
		after.RolePresentation = map[string]RolePresentation{"staff": {Name: "Staff", Color: "#5a89bc"}}
		if got := CheckRoleChange(before, after, "actor", nil, nil); got.Decision != Allowed {
			t.Fatal(got)
		}
		after.RolePresentation["staff"] = RolePresentation{Name: "Staff", Color: "#5a89bc", Mentionable: true}
		if got := CheckRoleChange(before, after, "actor", nil, nil); got.Decision != HierarchyDenied {
			t.Fatal(got)
		}
	})
	t.Run("cannot delegate rights on a hidden channel", func(t *testing.T) {
		before, after := snapshot(), snapshot()
		after.Members["target"] = Subject{ID: "target", Roles: []string{"low"}, Active: true}
		scope := Scope{Kind: "text", Local: &ACL{
			Profiles: map[string]Overwrite{"actor": {Deny: []string{ChannelView}}},
		}}
		if got := CheckRoleChange(before, after, "actor", []Scope{scope}, nil); got.Decision != EscalationDenied {
			t.Fatal(got)
		}
	})
	t.Run("cannot demote peer by deleting its highest role", func(t *testing.T) {
		before, after := snapshot(), snapshot()
		delete(after.Roles, "staff")
		after.Order = []string{"low"}
		after.Members["actor"] = Subject{ID: "actor", Active: true}
		after.Members["peer"] = Subject{ID: "peer", Roles: []string{"low"}, Active: true}
		if got := CheckRoleChange(before, after, "actor", nil, nil); got.Decision != HierarchyDenied {
			t.Fatal(got)
		}
	})
	t.Run("cannot get a new scoped grant through shared role", func(t *testing.T) {
		before, after := snapshot(), snapshot()
		actor := before.Members["actor"]
		actor.Roles = []string{"staff", "low"}
		before.Members["actor"], after.Members["actor"] = actor, actor
		peer := Subject{ID: "peer", Roles: []string{"staff"}, Active: true}
		before.Members["peer"], after.Members["peer"] = peer, peer
		delete(after.Roles, "low")
		after.Order = []string{"staff"}
		actor.Roles = []string{"staff"}
		after.Members["actor"] = actor
		scope := Scope{Kind: "text", Local: &ACL{Roles: map[string]Overwrite{"low": {Deny: []string{"message.send"}}}}}
		if got := CheckRoleChange(before, after, "actor", []Scope{scope}, nil); got.Decision != EscalationDenied {
			t.Fatal(got)
		}
	})
	t.Run("group administrator grant needs every recovery", func(t *testing.T) {
		before, after := snapshot(), snapshot()
		after.Roles["staff"] = Role{[]string{Administrator}}
		if got := CheckRoleChange(before, after, "owner", nil, map[string]bool{"actor": true}); got.Decision != RecoveryRequired || !slices.Equal(got.RecoveryProfiles, []string{"peer"}) {
			t.Fatal(got)
		}
	})
	t.Run("administrator on Everyone also gates admission", func(t *testing.T) {
		policy := snapshot().Policy
		if policy.CheckAdmission(false) != Allowed {
			t.Fatal("ordinary admission must not require recovery")
		}
		policy.Roles[Everyone] = Role{[]string{Administrator}}
		if policy.CheckAdmission(false) != RecoveryRequired || policy.CheckAdmission(true) != Allowed {
			t.Fatal("admission must validate implicit administrator grant")
		}
	})
}
