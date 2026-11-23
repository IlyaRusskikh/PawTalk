package access

import (
	"context"
	"maps"
	"slices"
)

// ApplyRoles accepts the final definitions and order, with sparse assignment
// replacements. Identity and recovery readiness come from the stored state.
func (s *Store) ApplyRoles(ctx context.Context, revision int64, actor string, roles map[string]Role, order []string, assignments map[string][]string) (int64, error) {
	return s.change(ctx, revision, actor, func(state *State) error {
		return state.applyRoles(actor, RolePolicyUpdate{Roles: roles, Order: order, Assignments: assignments})
	})
}

type RolePolicyUpdate struct {
	Roles        map[string]Role
	Order        []string
	Assignments  map[string][]string
	Presentation map[string]RolePresentation `json:",omitempty"`
}

func (state *State) applyRoles(actor string, update RolePolicyUpdate) error {
	roles, order, assignments := update.Roles, update.Order, update.Assignments
	before := state.RoleSnapshot
	presentation := make(map[string]RolePresentation, len(before.RolePresentation)+len(update.Presentation))
	for id, entry := range before.RolePresentation {
		if _, survives := roles[id]; survives {
			presentation[id] = entry
		}
	}
	maps.Copy(presentation, update.Presentation)
	if len(presentation) == 0 {
		presentation = nil
	}
	after := RoleSnapshot{
		Policy:  Policy{Owner: before.Owner, Roles: roles, Order: order, RolePresentation: presentation},
		Members: maps.Clone(before.Members),
	}
	for id := range assignments {
		if _, exists := before.Members[id]; !exists {
			return InvalidPolicy
		}
	}
	for id, member := range before.Members {
		if replacement, exists := assignments[id]; exists {
			member.Roles = replacement
		} else {
			member.Roles = slices.DeleteFunc(slices.Clone(member.Roles), func(role string) bool {
				_, exists := roles[role]
				return !exists
			})
		}
		after.Members[id] = member
	}
	var scopes []Scope
	for _, id := range slices.Sorted(maps.Keys(state.Categories)) {
		acl := state.Categories[id]
		scopes = append(scopes, Scope{Kind: "category", Local: &acl})
	}
	for _, id := range slices.Sorted(maps.Keys(state.Channels)) {
		scopes = append(scopes, state.scope(state.Channels[id]))
	}
	if result := CheckRoleChange(before, after, actor, scopes, state.RecoveryReady); result.Decision != Allowed {
		return RoleChangeFailure{result}
	}
	state.RoleSnapshot = after
	for id, acl := range state.Categories {
		dropDeletedRoleACL(acl, roles)
		state.Categories[id] = acl
	}
	for _, channel := range state.Channels {
		dropDeletedRoleACL(channel.ACL, roles)
	}
	return nil
}

func dropDeletedRoleACL(acl ACL, roles map[string]Role) {
	maps.DeleteFunc(acl.Roles, func(id string, _ Overwrite) bool {
		_, exists := roles[id]
		return !exists
	})
}

// SetChannelACL replaces the entire effective set and detaches it from the
// category. An editor starts from the effective set at its preview revision.
func (s *Store) SetChannelACL(ctx context.Context, revision int64, actorID, channelID string, acl ACL) (int64, error) {
	return s.change(ctx, revision, actorID, func(state *State) error {
		return state.setChannelACL(actorID, channelID, acl)
	})
}

func (state *State) setChannelACL(actorID, channelID string, acl ACL) error {
	channel, exists := state.Channels[channelID]
	if !exists {
		return ChannelRestricted
	}
	actor := state.Members[actorID]
	before := state.scope(channel)
	if result := state.CheckGrant(actor, before, "channel.access.edit", 0); result != Allowed {
		return result
	}
	if !state.validACL(acl, channel.Kind) {
		return InvalidPolicy
	}
	channel.Synchronized, channel.ACL = false, acl
	if err := state.checkACLChange(actor, before, state.scope(channel), true); err != nil {
		return err
	}
	state.Channels[channelID] = channel
	return nil
}

func (state *State) syncChannelACL(actorID, channelID string) error {
	channel, exists := state.Channels[channelID]
	if !exists {
		return ChannelRestricted
	}
	actor := state.Members[actorID]
	before := state.scope(channel)
	if result := state.CheckGrant(actor, before, "channel.access.edit", 0); result != Allowed {
		return result
	}
	if _, exists := state.Categories[channel.CategoryID]; !exists || channel.CategoryID == "" {
		return InvalidPolicy
	}
	channel.Synchronized, channel.ACL = true, ACL{}
	if err := state.checkACLChange(actor, before, state.scope(channel), false); err != nil {
		return err
	}
	state.Channels[channelID] = channel
	return nil
}

// SetCategoryACL updates the category and its synchronized children
// atomically. Custom channel overrides preserve their own effective rules.
func (s *Store) SetCategoryACL(ctx context.Context, revision int64, actorID, categoryID string, acl ACL) (int64, error) {
	return s.change(ctx, revision, actorID, func(state *State) error {
		return state.setCategoryACL(actorID, categoryID, acl)
	})
}

func (state *State) setCategoryACL(actorID, categoryID string, acl ACL) error {
	old, exists := state.Categories[categoryID]
	actor := state.Members[actorID]
	if !exists || !state.categoryVisible(actor, categoryID) {
		return ChannelRestricted
	}
	before := Scope{Kind: "category", Local: &old}
	if result := state.CheckGrant(actor, before, "channel.access.edit", 0); result != Allowed {
		return result
	}
	if !state.validACL(acl, "category") {
		return InvalidPolicy
	}
	if err := state.checkACLChange(actor, before, Scope{Kind: "category", Local: &acl}, false); err != nil {
		return err
	}
	for _, id := range slices.Sorted(maps.Keys(state.Channels)) {
		channel := state.Channels[id]
		if channel.Synchronized && channel.CategoryID == categoryID {
			before := state.scope(channel)
			after := before
			after.Category = &acl
			if err := state.checkACLChange(actor, before, after, false); err != nil {
				return err
			}
		}
	}
	state.Categories[categoryID] = acl
	return nil
}

func (s State) checkACLChange(actor Subject, before, after Scope, explicitAdminView bool) error {
	oldACL, newACL := before.effectiveACL(), after.effectiveACL()
	if before.Kind != "category" {
		oldRules, newRules := channelRules(*oldACL, before.Kind), channelRules(*newACL, after.Kind)
		oldACL, newACL = &oldRules, &newRules
	}
	for _, id := range slices.Sorted(maps.Keys(s.Members)) {
		oldRule, newRule := oldACL.Profiles[id], newACL.Profiles[id]
		if maps.Equal(grantSet(oldRule.Allow), grantSet(newRule.Allow)) &&
			maps.Equal(grantSet(oldRule.Deny), grantSet(newRule.Deny)) {
			continue
		}
		target := s.Members[id]
		if explicitAdminView && target.Active && !s.owner(target) && s.baseGrant(target, Administrator) &&
			(s.owner(actor) || s.baseGrant(actor, Administrator)) &&
			maps.Equal(grantSet(oldRule.Deny), grantSet(newRule.Deny)) &&
			maps.Equal(grantSetWithoutView(oldRule.Allow), grantSetWithoutView(newRule.Allow)) {
			continue
		}
		if result := s.CheckAction(actor, target, before, "channel.access.edit", false, 0); result != Allowed {
			return result
		}
	}
	for id, rule := range newACL.Roles {
		for _, grant := range rule.Allow {
			if !slices.Contains(oldACL.Roles[id].Allow, grant) && !s.grant(actor, before, grant) {
				return EscalationDenied
			}
		}
	}
	for _, subject := range s.Members {
		for _, permission := range orderedPermissions {
			if !s.delegableGrant(subject, before, permission) && s.delegableGrant(subject, after, permission) &&
				((!s.owner(actor) && subject.ID == actor.ID) || !s.delegableGrant(actor, before, permission)) {
				return EscalationDenied
			}
		}
	}
	return nil
}

func grantSetWithoutView(values []string) map[string]bool {
	result := grantSet(values)
	delete(result, ChannelView)
	return result
}

func channelRules(acl ACL, kind string) ACL {
	filter := func(rules map[string]Overwrite) map[string]Overwrite {
		out := make(map[string]Overwrite)
		inapplicable := func(id string) bool { return !fitsScope(permissions[id].Scope, kind) }
		for id, rule := range rules {
			allow := slices.DeleteFunc(slices.Clone(rule.Allow), inapplicable)
			deny := slices.DeleteFunc(slices.Clone(rule.Deny), inapplicable)
			if len(allow)+len(deny) != 0 {
				out[id] = Overwrite{Allow: allow, Deny: deny}
			}
		}
		return out
	}
	return ACL{Roles: filter(acl.Roles), Profiles: filter(acl.Profiles)}
}
