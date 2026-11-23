package access

import (
	"maps"
	"slices"
)

const (
	InvalidPolicy    Decision = "invalid_policy"
	EscalationDenied Decision = "escalation_denied"
	RecoveryRequired Decision = "recovery_required"
)

type RoleSnapshot struct {
	Policy
	Members map[string]Subject
}

type RoleChangeResult struct {
	Decision
	RecoveryProfiles []string
}

// CheckAdmission checks the Administrator prerequisite for the implicit
// Everyone assignment. The caller verifies identity and invite redemption.
func (p Policy) CheckAdmission(recoveryReady bool) Decision {
	if p.baseGrant(Subject{}, Administrator) && !recoveryReady {
		return RecoveryRequired
	}
	return Allowed
}

func (p Policy) validRoles() bool {
	if p.Owner == "" || len(p.Roles) != len(p.Order)+1 {
		return false
	}
	seen := map[string]bool{Everyone: true}
	for _, id := range p.Order {
		if id == "" || seen[id] {
			return false
		}
		seen[id] = true
	}
	for id, role := range p.Roles {
		if !seen[id] {
			return false
		}
		for _, grant := range role.Grants {
			if _, known := permissions[grant]; !known {
				return false
			}
		}
	}
	for id, presentation := range p.RolePresentation {
		if !seen[id] || !presentation.valid() {
			return false
		}
	}
	return true
}

func grantSet(ids []string) map[string]bool {
	idsSet := make(map[string]bool, len(ids))
	for _, id := range ids {
		idsSet[id] = true
	}
	return idsSet
}

func (s RoleSnapshot) valid() bool {
	if !s.validRoles() || s.Members[s.Owner].ID != s.Owner || !s.Members[s.Owner].Active {
		return false
	}
	for id, member := range s.Members {
		if id == "" || member.ID != id {
			return false
		}
		for _, role := range member.Roles {
			if _, exists := s.Roles[role]; !exists || role == Everyone {
				return false
			}
		}
	}
	return true
}

// CheckRoleChange compares the complete policy and all effective profiles.
// Call with snapshots from the write transaction, including every ACL scope.
// Assignments implicitly removed by deletion are treated as edits to the role.
func CheckRoleChange(before, after RoleSnapshot, actorID string, scopes []Scope, recoveryReady map[string]bool) RoleChangeResult {
	if !before.valid() || !after.valid() || before.Owner != after.Owner || len(before.Members) != len(after.Members) {
		return RoleChangeResult{Decision: InvalidPolicy}
	}
	actor := before.Members[actorID]
	if !actor.Active {
		return RoleChangeResult{Decision: Inactive}
	}
	if decision := checkDefinitions(before.Policy, after.Policy, actor); decision != Allowed {
		return RoleChangeResult{Decision: decision}
	}
	owner := before.owner(actor)
	actorRank := before.rank(actor)
	actorAdmin := owner || before.baseGrant(actor, Administrator)
	var needsRecovery []string
	for _, id := range slices.Sorted(maps.Keys(before.Members)) {
		previous := before.Members[id]
		next, exists := after.Members[id]
		if !exists || previous.Active != next.Active || previous.TimeoutUntil != next.TimeoutUntil {
			return RoleChangeResult{Decision: InvalidPolicy}
		}
		previousRoles := grantSet(previous.Roles)
		for _, role := range previous.Roles {
			if _, survives := after.Roles[role]; !survives {
				delete(previousRoles, role)
			}
		}
		nextRoles := grantSet(next.Roles)
		if !maps.Equal(previousRoles, nextRoles) {
			if decision := before.CheckAction(actor, previous, Scope{}, "role.assign", false, 0); decision != Allowed {
				return RoleChangeResult{Decision: decision}
			}
			if !owner {
				for role := range previousRoles {
					if !nextRoles[role] && slices.Index(before.Order, role)+1 >= actorRank {
						return RoleChangeResult{Decision: HierarchyDenied}
					}
				}
				for role := range nextRoles {
					if previousRoles[role] {
						continue
					}
					if slices.Index(after.Order, role) >= slices.Index(after.Order, highestRole(before.Policy, actor)) {
						return RoleChangeResult{Decision: HierarchyDenied}
					}
					for _, grant := range after.Roles[role].Grants {
						if !actorAdmin && !before.baseGrant(actor, grant) {
							return RoleChangeResult{Decision: EscalationDenied}
						}
					}
				}
			}
		}
		if !next.Active {
			continue
		}
		wasAdmin, isAdmin := before.baseGrant(previous, Administrator), after.baseGrant(next, Administrator)
		if !wasAdmin && isAdmin && !after.owner(next) && !recoveryReady[id] {
			needsRecovery = append(needsRecovery, id)
		}
		if owner || before.owner(previous) {
			continue
		}
		if before.rank(previous) >= actorRank && highestRole(before.Policy, previous) != highestRole(after.Policy, next) {
			return RoleChangeResult{Decision: HierarchyDenied}
		}
		for _, permissionID := range orderedPermissions {
			entry := permissions[permissionID]
			if decision := checkChangedGrant(before.Policy, after.Policy, actor, actorAdmin, previous, next, Scope{}, permissionID); decision != Allowed {
				return RoleChangeResult{Decision: decision}
			}
			for _, scope := range scopes {
				if fitsScope(entry.Scope, scope.Kind) {
					if decision := checkChangedGrant(before.Policy, after.Policy, actor, actorAdmin, previous, next, scope, permissionID); decision != Allowed {
						return RoleChangeResult{Decision: decision}
					}
				}
			}
		}
	}
	if len(needsRecovery) > 0 {
		return RoleChangeResult{Decision: RecoveryRequired, RecoveryProfiles: needsRecovery}
	}
	return RoleChangeResult{Decision: Allowed}
}

func highestRole(p Policy, member Subject) string {
	for i := len(p.Order) - 1; i >= 0; i-- {
		if slices.Contains(member.Roles, p.Order[i]) {
			return p.Order[i]
		}
	}
	return Everyone
}

func checkDefinitions(before, after Policy, actor Subject) Decision {
	owner := before.owner(actor)
	anchor := highestRole(before, actor)
	if !owner {
		for _, order := range [][]string{before.Order, after.Order} {
			if anchor != Everyone && !slices.Contains(order, anchor) {
				return HierarchyDenied
			}
		}
		// Anything at or above the actor is outside the editable role range.
		if !slices.Equal(rolesAtOrAbove(before.Order, anchor), rolesAtOrAbove(after.Order, anchor)) {
			return HierarchyDenied
		}
	}
	changed := !slices.Equal(before.Order, after.Order)
	roles := maps.Clone(before.Roles)
	maps.Copy(roles, after.Roles)
	for _, id := range slices.Sorted(maps.Keys(roles)) {
		oldRole, oldExists := before.Roles[id]
		newRole, newExists := after.Roles[id]
		oldGrants, newGrants := grantSet(oldRole.Grants), grantSet(newRole.Grants)
		if oldExists == newExists && maps.Equal(oldGrants, newGrants) && before.RolePresentation[id] == after.RolePresentation[id] {
			continue
		}
		changed = true
		ownPresentation := oldExists && newExists && maps.Equal(oldGrants, newGrants) &&
			slices.Contains(actor.Roles, id) && before.baseGrant(actor, Administrator) &&
			before.RolePresentation[id].Hoist == after.RolePresentation[id].Hoist &&
			before.RolePresentation[id].Mentionable == after.RolePresentation[id].Mentionable
		if !owner && slices.Index(before.Order, id)+1 >= before.rank(actor) && !ownPresentation {
			return HierarchyDenied
		}
		if !owner && !before.baseGrant(actor, Administrator) {
			for grant := range newGrants {
				if !oldGrants[grant] && !before.baseGrant(actor, grant) {
					return EscalationDenied
				}
			}
		}
	}
	if changed {
		return before.CheckGrant(actor, Scope{}, "role.edit", 0)
	}
	return Allowed
}

func rolesAtOrAbove(order []string, anchor string) []string {
	if anchor == Everyone {
		return order
	}
	return order[slices.Index(order, anchor):]
}

func checkChangedGrant(before, after Policy, actor Subject, actorAdmin bool, previous, next Subject, scope Scope, id string) Decision {
	oldGrant := before.delegableGrant(previous, scope, id)
	newGrant := after.delegableGrant(next, scope, id)
	if oldGrant == newGrant {
		return Allowed
	}
	if newGrant && (previous.ID == actor.ID || !actorAdmin && !before.delegableGrant(actor, scope, id)) {
		return EscalationDenied
	}
	if previous.ID != actor.ID && before.rank(previous) >= before.rank(actor) {
		return HierarchyDenied
	}
	return Allowed
}

func (p Policy) delegableGrant(subject Subject, scope Scope, id string) bool {
	if scope.Kind == "" {
		return p.grant(subject, scope, id)
	}
	// A temporary timeout affects operation, not the underlying role grants.
	subject.TimeoutUntil = 0
	return p.CheckGrant(subject, scope, id, 0) == Allowed
}
