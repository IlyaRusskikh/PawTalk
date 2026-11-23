package access

import (
	"context"
	"maps"
	"slices"
)

func readAuditChannelACLChange(ctx context.Context, query SessionQuery, draft PolicyDraft) (AuditChange, error) {
	before, _, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return AuditChange{}, err
	}
	after, revision, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return AuditChange{}, err
	}
	if revision != draft.Revision {
		return AuditChange{}, ErrPolicyConflict
	}
	id := draft.ResourceChange.ID
	oldChannel, oldExists := before.Channels[id]
	newChannel, newExists := after.Channels[id]
	if !oldExists || !newExists || oldChannel.Kind != newChannel.Kind {
		return AuditChange{}, ErrPolicyConflict
	}
	oldRules := channelRules(*before.scope(oldChannel).effectiveACL(), oldChannel.Kind)
	newRules := channelRules(*after.scope(newChannel).effectiveACL(), newChannel.Kind)

	added, removed := make(map[string]bool), make(map[string]bool)
	switch draft.Action {
	case EditScopedChannelACLPersonal:
		target := draft.ResourceChange.TargetProfileID
		collectAuditOverwriteChange(oldRules.Profiles[target], newRules.Profiles[target], added, removed)
	case EditScopedChannelACLRoleRules:
		collectAuditRuleChanges(oldRules.Roles, newRules.Roles, added, removed)
	default:
		collectAuditRuleChanges(oldRules.Roles, newRules.Roles, added, removed)
		collectAuditRuleChanges(oldRules.Profiles, newRules.Profiles, added, removed)
	}
	return AuditChange{Added: slices.Sorted(maps.Keys(added)), Removed: slices.Sorted(maps.Keys(removed))}, nil
}

func collectAuditRuleChanges(before, after map[string]Overwrite, added, removed map[string]bool) {
	for id, old := range before {
		collectAuditOverwriteChange(old, after[id], added, removed)
	}
	for id, current := range after {
		if _, exists := before[id]; !exists {
			collectAuditOverwriteChange(Overwrite{}, current, added, removed)
		}
	}
}

// Record the permission and the rule that changed, without carrying rule
// owner IDs, unaffiliated channels or the original policy data.
func collectAuditOverwriteChange(before, after Overwrite, added, removed map[string]bool) {
	for _, rule := range []struct {
		prefix        string
		before, after []string
	}{
		{"allow:", before.Allow, after.Allow},
		{"deny:", before.Deny, after.Deny},
	} {
		change := auditSetChange(rule.before, rule.after)
		for _, permission := range change.Added {
			added[rule.prefix+permission] = true
		}
		for _, permission := range change.Removed {
			removed[rule.prefix+permission] = true
		}
	}
}
