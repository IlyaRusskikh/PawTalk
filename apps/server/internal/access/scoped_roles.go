package access

import (
	"context"
	"database/sql"
	"encoding/hex"
	"maps"
	"slices"
)

type ScopedRoleDefinition struct {
	ID           string            `json:"id"`
	Grants       []string          `json:"grants"`
	Presentation *RolePresentation `json:"presentation,omitempty"`
}

type ScopedRoleOption struct {
	ID        string `json:"id"`
	Name      string `json:"name,omitempty"`
	Assigned  bool   `json:"assigned"`
	CanAssign bool   `json:"canAssign"`
}

type ScopedRoleBasis struct {
	Revision      int64                   `json:"revision"`
	PolicyHead    string                  `json:"policyHead"`
	Definitions   *[]ScopedRoleDefinition `json:"definitions,omitempty"`
	Assignments   *[]ScopedRoleOption     `json:"assignments,omitempty"`
	GrantOptions  []string                `json:"grantOptions,omitempty"`
	TargetProfile string                  `json:"targetProfileId,omitempty"`
	RosterChannel string                  `json:"rosterChannelId,omitempty"`
}

// ScopedRoleChange describes just one kind of delegated action. Editable roles
// change only through explicit upserts and deletes. An order, when supplied,
// must enumerate every remaining editable ordinary role.
type ScopedRoleChange struct {
	Revision         int64                   `json:"revision"`
	PolicyHead       string                  `json:"policyHead"`
	Definitions      *[]ScopedRoleDefinition `json:"definitions,omitempty"`
	Delete           []string                `json:"delete,omitempty"`
	Order            *[]string               `json:"order,omitempty"`
	TargetProfile    string                  `json:"targetProfileId,omitempty"`
	RosterChannel    string                  `json:"rosterChannelId,omitempty"`
	RosterCommitment string                  `json:"rosterCommitment,omitempty"`
	Add              []string                `json:"add,omitempty"`
	Remove           []string                `json:"remove,omitempty"`
}

type ScopedRolePreview struct {
	Revision   int64                     `json:"revision"`
	PolicyHead string                    `json:"policyHead"`
	Channels   []ScopedRoleChannelImpact `json:"channels"`
	RosterSalt string                    `json:"rosterSalt,omitempty"`
}

type ScopedRoleChannelImpact struct {
	ID          string `json:"id"`
	ViewAdded   int    `json:"viewAdded"`
	ViewRemoved int    `json:"viewRemoved"`
	FullAdded   int    `json:"fullHistoryAdded"`
	FullRemoved int    `json:"fullHistoryRemoved"`
	KeyUpdate   bool   `json:"keyUpdate"`
}

func (s State) scopedRoleChannelReaders(actor Principal) map[string]map[string]bool {
	visible := make(map[string]map[string]bool)
	for id, channel := range s.Channels {
		if s.CanDeliver(actor.ProfileID, id, 0) {
			visible[id] = s.channelReaders(channel)
		}
	}
	return visible
}

func (s State) scopedRoleImpacts(visibleBefore map[string]map[string]bool) []ScopedRoleChannelImpact {
	impacts := make([]ScopedRoleChannelImpact, 0)
	for _, id := range slices.Sorted(maps.Keys(visibleBefore)) {
		channel := s.Channels[id]
		before, after := visibleBefore[id], s.channelReaders(channel)
		if maps.Equal(before, after) {
			continue
		}
		impact := ScopedRoleChannelImpact{ID: id, KeyUpdate: channel.Kind == "text"}
		for profile, full := range before {
			stillFull, stillSees := after[profile]
			if !stillSees {
				impact.ViewRemoved++
			}
			if full && !stillFull {
				impact.FullRemoved++
			}
		}
		for profile, full := range after {
			wasFull, saw := before[profile]
			if !saw {
				impact.ViewAdded++
			}
			if full && !wasFull {
				impact.FullAdded++
			}
		}
		impacts = append(impacts, impact)
	}
	return impacts
}

func (s State) scopedRoleUpdate(actor Principal, change ScopedRoleChange) (RolePolicyUpdate, error) {
	if change.Definitions == nil && len(change.Delete) == 0 && change.Order == nil {
		return s.scopedRoleAssignmentUpdate(actor, change)
	}
	if change.TargetProfile != "" || change.RosterChannel != "" || len(change.Add)+len(change.Remove) != 0 {
		return RolePolicyUpdate{}, InvalidAction
	}
	subject := s.Members[actor.ProfileID]
	if decision := s.CheckGrant(subject, Scope{}, "role.edit", 0); decision != Allowed {
		return RolePolicyUpdate{}, decision
	}
	// Keep the anchor and all roles above it verbatim, including fields the
	// delegated editor never received.
	rank := s.rank(subject)
	if rank == 0 {
		return RolePolicyUpdate{}, HierarchyDenied
	}
	editableOrder, protectedOrder := slices.Clone(s.Order[:rank-1]), s.Order[rank-1:]
	update := RolePolicyUpdate{Roles: maps.Clone(s.Roles), Presentation: make(map[string]RolePresentation)}
	for _, id := range change.Delete {
		index := slices.Index(editableOrder, id)
		if index < 0 {
			return RolePolicyUpdate{}, HierarchyDenied
		}
		editableOrder = slices.Delete(editableOrder, index, index+1)
		delete(update.Roles, id)
	}
	if change.Definitions != nil {
		seen := make(map[string]bool)
		for _, definition := range *change.Definitions {
			id := definition.ID
			if seen[id] || id == "" || slices.Contains(change.Delete, id) || len(grantSet(definition.Grants)) != len(definition.Grants) {
				return RolePolicyUpdate{}, InvalidPolicy
			}
			seen[id] = true
			if slices.Contains(protectedOrder, id) {
				return RolePolicyUpdate{}, HierarchyDenied
			}
			if _, exists := update.Roles[id]; !exists {
				editableOrder = append(editableOrder, id)
			}
			update.Roles[id] = Role{Grants: definition.Grants}
			if definition.Presentation != nil {
				update.Presentation[id] = *definition.Presentation
			}
		}
	}
	if change.Order != nil {
		if len(*change.Order) != len(editableOrder) || !maps.Equal(grantSet(*change.Order), grantSet(editableOrder)) {
			return RolePolicyUpdate{}, HierarchyDenied
		}
		editableOrder = slices.Clone(*change.Order)
	}
	update.Order = append(append([]string{}, editableOrder...), protectedOrder...)
	return update, nil
}

func (s State) scopedRoleAssignmentUpdate(actor Principal, change ScopedRoleChange) (RolePolicyUpdate, error) {
	if !isDigest(change.TargetProfile) || change.RosterChannel != "" && !validRotationID(change.RosterChannel) ||
		len(change.Add)+len(change.Remove) == 0 {
		return RolePolicyUpdate{}, InvalidAction
	}
	target, err := s.scopedRoleAssignmentTarget(actor, change.RosterChannel, change.TargetProfile)
	if err != nil {
		return RolePolicyUpdate{}, err
	}
	roles := grantSet(target.Roles)
	for _, id := range change.Remove {
		if !roles[id] {
			return RolePolicyUpdate{}, InvalidPolicy
		}
		delete(roles, id)
	}
	for _, id := range change.Add {
		if roles[id] || slices.Contains(change.Remove, id) || id == Everyone {
			return RolePolicyUpdate{}, InvalidPolicy
		}
		if _, exists := s.Roles[id]; !exists {
			return RolePolicyUpdate{}, InvalidPolicy
		}
		roles[id] = true
	}
	return RolePolicyUpdate{Roles: s.Roles, Order: s.Order,
		Assignments: map[string][]string{target.ID: slices.Sorted(maps.Keys(roles))}}, nil
}

func (s State) scopedRoleAssignmentTarget(actor Principal, rosterChannel, targetID string) (Subject, error) {
	subject := s.Members[actor.ProfileID]
	if decision := s.CheckGrant(subject, Scope{}, "role.assign", 0); decision != Allowed {
		return Subject{}, decision
	}
	target := s.Members[targetID]
	if rosterChannel == "" {
		if s.CheckGrant(subject, Scope{}, "member.list", 0) != Allowed {
			return Subject{}, ChannelRestricted
		}
	} else if s.Channels[rosterChannel].Kind != "text" || !s.CanDeliver(subject.ID, rosterChannel, 0) ||
		!s.CanDeliver(targetID, rosterChannel, 0) {
		return Subject{}, ChannelRestricted
	}
	if !target.Active || s.CheckAction(subject, target, Scope{}, "role.assign", false, 0) != Allowed {
		return Subject{}, ChannelRestricted
	}
	return target, nil
}

func (s State) scopedRoleBasis(actor Principal, rosterChannel, targetID string) (ScopedRoleBasis, error) {
	if !s.PolicyAnchored || !s.hasPolicyDevice(actor) {
		return ScopedRoleBasis{}, Inactive
	}
	subject := s.Members[actor.ProfileID]
	rank := s.rank(subject)
	unrestrictedGrants := s.owner(subject) || s.baseGrant(subject, Administrator)
	if targetID != "" {
		target, err := s.scopedRoleAssignmentTarget(actor, rosterChannel, targetID)
		if err != nil {
			return ScopedRoleBasis{}, err
		}
		options := make([]ScopedRoleOption, 0)
		for index, id := range s.Order {
			if index+1 >= rank {
				break
			}
			canAssign := unrestrictedGrants || !slices.ContainsFunc(s.Roles[id].Grants, func(grant string) bool {
				return !s.baseGrant(subject, grant)
			})
			assigned := slices.Contains(target.Roles, id)
			if canAssign || assigned {
				options = append(options, ScopedRoleOption{ID: id, Name: s.RolePresentation[id].Name, Assigned: assigned, CanAssign: canAssign})
			}
		}
		return ScopedRoleBasis{TargetProfile: targetID, RosterChannel: rosterChannel, Assignments: &options}, nil
	}
	if decision := s.CheckGrant(subject, Scope{}, "role.edit", 0); decision != Allowed {
		return ScopedRoleBasis{}, decision
	}
	definitions := make([]ScopedRoleDefinition, 0, rank)
	for index, id := range append([]string{Everyone}, s.Order...) {
		if index >= rank {
			break
		}
		definition := ScopedRoleDefinition{ID: id, Grants: append([]string{}, s.Roles[id].Grants...)}
		if entry, exists := s.RolePresentation[id]; exists {
			definition.Presentation = &entry
		}
		definitions = append(definitions, definition)
	}
	grants := make([]string, 0)
	for _, id := range orderedPermissions {
		if unrestrictedGrants || s.baseGrant(subject, id) {
			grants = append(grants, id)
		}
	}
	return ScopedRoleBasis{Definitions: &definitions, GrantOptions: grants}, nil
}

// DispatchScopedRoleBasis exposes only roles relevant to the requested action.
// The complete policy remains inside the same authorized read transaction.
func (s *Store) DispatchScopedRoleBasis(ctx context.Context, resolve ResolveSession, rosterChannel, targetID string,
	deliver func(ScopedRoleBasis) error) error {
	if rosterChannel != "" && (targetID == "" || !validRotationID(rosterChannel)) || targetID != "" && !isDigest(targetID) {
		return InvalidAction
	}
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		basis, err := state.scopedRoleBasis(actor, rosterChannel, targetID)
		if err != nil {
			return err
		}
		head, err := readPolicyHead(ctx, conn)
		if err != nil {
			return err
		}
		basis.Revision, basis.PolicyHead = head.Draft.Revision, head.Digest
		return deliver(basis)
	})
}

func (s *Store) DispatchScopedRolePreview(ctx context.Context, resolve ResolveSession, change ScopedRoleChange,
	deliver func(ScopedRolePreview) error) error {
	if change.Revision < 1 || !isDigest(change.PolicyHead) || change.RosterCommitment != "" {
		return InvalidAction
	}
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) {
			return Inactive
		}
		update, err := state.scopedRoleUpdate(actor, change)
		if err != nil {
			return err
		}
		head, err := readPolicyHead(ctx, conn)
		if err != nil {
			return err
		}
		if head.Draft.Revision != change.Revision || head.Digest != change.PolicyHead {
			return ErrPolicyConflict
		}
		visibleBefore := state.scopedRoleChannelReaders(actor)
		if err := state.applyRoles(actor.ProfileID, update); err != nil {
			return err
		}
		preview := ScopedRolePreview{Revision: change.Revision, PolicyHead: change.PolicyHead,
			Channels: state.scopedRoleImpacts(visibleBefore)}
		if change.RosterChannel != "" && head.Draft.TextProjectionVersion == ProfileRoleAuthorityProjectionVersion {
			var seed [32]byte
			if !isDigest(head.Draft.TextProjectionSeed) {
				return ErrPolicyConflict
			}
			_, _ = hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed))
			_, preview.RosterSalt = scopedRoleRosterAlias(seed, change.RosterChannel)
		}
		return deliver(preview)
	})
}
