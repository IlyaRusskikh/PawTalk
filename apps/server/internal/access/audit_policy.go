package access

import (
	"context"
	"database/sql"
	"maps"
	"slices"
)

func recordPolicyAudit(ctx context.Context, tx *sql.Tx, now int64, actor Principal, draft PolicyDraft, before, after RoleSnapshot, replacesRecovery bool, deletedResourceName string) error {
	event := AuditEvent{At: now, Actor: actor.ProfileID, Action: draft.Action}
	switch draft.Action {
	case AnchorPolicy:
		return nil
	case UpdatePolicyRoles, EditScopedRoles:
		event.Action = UpdatePolicyRoles
		return recordRoleAudit(ctx, tx, event, before, after)
	case EnrollPolicyDevice, RevokePolicyDevice:
		event.Kind, event.ObjectID = "device", draft.DeviceChange.DeviceID
	case RecoverPolicyDevice:
		event.Kind, event.ObjectID = "device", actor.DeviceID
	case MoveScopeDevice:
		key := parseScopeAuthorityKey(draft.ResourceChange.ScopeDeviceHandover.Link.DeviceKey)
		if key == nil {
			return ErrScopeAuthority
		}
		event.Kind, event.ObjectID = "device", hexHash(key)
	case BindPolicyDevice:
		applicant, err := deviceBindingApplicant(draft.ResourceChange)
		if err != nil {
			return err
		}
		event.Kind, event.ObjectID = "device", applicant.DeviceID
	case TransferPolicyOwnership:
		event.Kind, event.ObjectID = "member", draft.ResourceChange.ID
	case LinkPolicyProfiles:
		event.Kind, event.ObjectID = "member", draft.ResourceChange.ProfileLink.SecondaryProfileID
	case UnlinkPolicyProfile:
		event.Kind, event.ObjectID = "member", draft.ResourceChange.ID
	case EditScopedChannelSettings:
		event.Action, event.Kind = EditPolicyChannel, "channel"
		event.ObjectID, event.ChannelID = draft.ResourceChange.ID, draft.ResourceChange.ID
	case EditScopedChannelACLRoleRules, UpdateChannelACL, SyncChannelACL, MovePolicyChannel:
		if draft.Action == EditScopedChannelACLRoleRules {
			event.Action = UpdateChannelACL
		}
		event.Kind = "channel"
		event.ObjectID, event.ChannelID = draft.ResourceChange.ID, draft.ResourceChange.ID
	case EditScopedChannelACLPersonal:
		event.Action, event.Kind = UpdateChannelACL, "member"
		event.ObjectID, event.ChannelID = draft.ResourceChange.TargetProfileID, draft.ResourceChange.ID
	case EnrollRecipientKey, RevokeRecipientKey:
		event.Kind, event.ObjectID = "member", actor.ProfileID
	case EnrollPolicyRecovery, ConfirmPolicyRecovery:
		event.Kind, event.ObjectID = "member", actor.ProfileID
		if replacesRecovery {
			event.Action = "recovery.replace"
		}
	case AdmitInviteMember, RedeemPolicyInvite, LeavePolicyMember:
		event.Kind, event.ObjectID = "member", draft.ResourceChange.ID
	case KickPolicyMember, BanPolicyMember, LiftPolicyMemberBan:
		event.Kind, event.ObjectID, event.Reason = "member", draft.ResourceChange.ID, draft.ResourceChange.Departure.Reason
		if draft.Action == BanPolicyMember {
			event.Change.Current = &draft.ResourceChange.Departure.ExpiresAt
		}
	case UpdateCategoryACL, CreatePolicyCategory, CopyPolicyCategory, RenamePolicyCategory, DeletePolicyCategory, OrderPolicyCategory:
		event.Kind, event.ObjectID = "category", draft.ResourceChange.ID
		event.category = event.ObjectID
	case ChangeVoiceMute, ChangeVoiceDeafen:
		event.Kind, event.ObjectID = "member", draft.ResourceChange.TargetProfileID
		event.ChannelID = draft.ResourceChange.ID
		if draft.ResourceChange.Lift {
			event.Action += ".lift"
		}
	default:
		event.Kind, event.ObjectID = "channel", draft.ResourceChange.ID
		event.ChannelID = event.ObjectID
	}
	switch draft.Action {
	case EditScopedChannelACLRoleRules, EditScopedChannelACLPersonal, UpdateChannelACL, SyncChannelACL, MovePolicyChannel:
		change, err := readAuditChannelACLChange(ctx, tx, draft)
		if err != nil {
			return err
		}
		event.Change = change
	}
	event.Change.ObjectName = deletedResourceName
	return recordAudit(ctx, tx, event)
}

func recordRoleAudit(ctx context.Context, tx *sql.Tx, event AuditEvent, before, after RoleSnapshot) error {
	if !slices.Equal(before.Order, after.Order) {
		ordered := event
		ordered.Action, ordered.Kind = "role.order", "server"
		if err := recordAudit(ctx, tx, ordered); err != nil {
			return err
		}
	}
	roles := maps.Clone(before.Roles)
	maps.Copy(roles, after.Roles)
	for _, id := range slices.Sorted(maps.Keys(roles)) {
		old, wasPresent := before.Roles[id]
		current, isPresent := after.Roles[id]
		change := auditSetChange(old.Grants, current.Grants)
		if wasPresent == isPresent && len(change.Added)+len(change.Removed) == 0 && before.RolePresentation[id] == after.RolePresentation[id] {
			continue
		}
		role := event
		role.Kind, role.ObjectID, role.Change = "role", id, change
		switch {
		case !wasPresent:
			role.Action = "role.create"
		case !isPresent:
			role.Action = "role.delete"
			role.Change.ObjectName = before.RolePresentation[id].Name
		default:
			role.Action = "role.update"
		}
		if err := recordAudit(ctx, tx, role); err != nil {
			return err
		}
	}
	for _, id := range slices.Sorted(maps.Keys(after.Members)) {
		change := auditSetChange(before.Members[id].Roles, after.Members[id].Roles)
		if len(change.Added)+len(change.Removed) == 0 {
			continue
		}
		member := event
		member.Kind, member.ObjectID, member.Action, member.Change = "member", id, "role.assign", change
		if err := recordAudit(ctx, tx, member); err != nil {
			return err
		}
	}
	return nil
}

func auditSetChange(before, after []string) AuditChange {
	old, current := grantSet(before), grantSet(after)
	var change AuditChange
	for _, id := range slices.Sorted(maps.Keys(current)) {
		if !old[id] {
			change.Added = append(change.Added, id)
		}
	}
	for _, id := range slices.Sorted(maps.Keys(old)) {
		if !current[id] {
			change.Removed = append(change.Removed, id)
		}
	}
	return change
}
