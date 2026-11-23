// Package access implements the protected-access policy independently of storage.
package access

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Role struct {
	Grants []string
}

type RolePresentation struct {
	Name        string
	Color       string `json:",omitempty"`
	Icon        string `json:",omitempty"`
	Hoist       bool   `json:",omitempty"`
	Mentionable bool   `json:",omitempty"`
}

func (p RolePresentation) valid() bool {
	validText := func(value string, max int) bool {
		return utf8.ValidString(value) && utf8.RuneCountInString(value) <= max &&
			strings.TrimSpace(value) == value && strings.IndexFunc(value, unicode.IsControl) < 0
	}
	return p.Name != "" && validText(p.Name, 64) && validText(p.Icon, 32) &&
		(p.Color == "" || len(p.Color) == 7 && p.Color[0] == '#' && strings.Trim(p.Color[1:], "0123456789abcdef") == "")
}

type Policy struct {
	Owner string
	Roles map[string]Role
	// Order contains ordinary role IDs from lowest to highest. Everyone has rank zero.
	Order            []string
	RolePresentation map[string]RolePresentation `json:",omitempty"`
}

type Subject struct {
	// ID identifies the effective profile. Active includes verified session,
	// device and membership status and excludes bans.
	ID           string
	Roles        []string
	Active       bool
	TimeoutUntil int64 // UTC Unix milliseconds
}

type Overwrite struct {
	Allow []string
	Deny  []string
}

type ACL struct {
	Roles    map[string]Overwrite
	Profiles map[string]Overwrite
}

type Scope struct {
	Kind         string // "", "category", "text" or "voice"
	Category     *ACL
	Local        *ACL
	Synchronized bool
}

type Decision string

const (
	Allowed           Decision = "allowed"
	Inactive          Decision = "inactive"
	InvalidAction     Decision = "invalid_action"
	WrongScope        Decision = "wrong_scope"
	MissingGrant      Decision = "missing_grant"
	ChannelRestricted Decision = "channel_restricted"
	TimedOut          Decision = "timed_out"
	HierarchyDenied   Decision = "hierarchy_denied"
)

func (p Policy) owner(s Subject) bool { return p.Owner != "" && p.Owner == s.ID }

func (p Policy) rank(s Subject) int {
	if p.owner(s) {
		return len(p.Order) + 1
	}
	rank := 0
	for _, id := range s.Roles {
		rank = max(rank, slices.Index(p.Order, id)+1)
	}
	return rank
}

func (p Policy) baseGrant(s Subject, id string) bool {
	if slices.Contains(p.Roles[Everyone].Grants, id) {
		return true
	}
	for _, roleID := range s.Roles {
		if slices.Contains(p.Roles[roleID].Grants, id) {
			return true
		}
	}
	return false
}

func (o Overwrite) apply(id string, allowed bool) bool {
	return slices.Contains(o.Allow, id) || allowed && !slices.Contains(o.Deny, id)
}

func (s Scope) effectiveACL() *ACL {
	if s.Synchronized {
		return s.Category
	}
	return s.Local
}

func (p Policy) grant(s Subject, scope Scope, id string) bool {
	if p.owner(s) || p.baseGrant(s, Administrator) {
		return true
	}
	allowed := p.baseGrant(s, id)
	acl := scope.effectiveACL()
	if acl == nil {
		return allowed
	}
	allowed = acl.Roles[Everyone].apply(id, allowed)
	var allow, deny bool
	for _, roleID := range s.Roles {
		if roleID == Everyone {
			continue
		}
		override := acl.Roles[roleID]
		allow = allow || slices.Contains(override.Allow, id)
		deny = deny || slices.Contains(override.Deny, id)
	}
	return acl.Profiles[s.ID].apply(id, allow || allowed && !deny)
}

func fitsScope(required, kind string) bool {
	switch required {
	case "server":
		return kind == ""
	case "resource":
		return kind == "category" || kind == "text" || kind == "voice"
	case "channel":
		return kind == "text" || kind == "voice"
	case "category":
		// Root has no category ACL.
		return kind == "" || kind == "category"
	case "text", "voice":
		return kind == required
	default:
		return false
	}
}

// CheckGrant evaluates the action's scope, channel visibility and permission
// prerequisites. Object history, authorship, quotas and key readiness are
// checked by the operation using its current transaction.
func (p Policy) CheckGrant(s Subject, scope Scope, id string, now int64) Decision {
	if !s.Active || s.ID == "" {
		return Inactive
	}
	entry, found := permissions[id]
	if !found {
		return InvalidAction
	}
	if !fitsScope(entry.Scope, scope.Kind) {
		return WrongScope
	}
	if scope.Kind == "" {
		scope = Scope{}
	}
	if (scope.Kind == "text" || scope.Kind == "voice") && !p.grant(s, scope, ChannelView) {
		return ChannelRestricted
	}
	if !p.grant(s, scope, id) {
		return MissingGrant
	}
	if entry.BlockedByTimeout && s.TimeoutUntil > now {
		return TimedOut
	}
	for _, dependency := range entry.Requires {
		if result := p.CheckGrant(s, scope, dependency, now); result != Allowed {
			return result
		}
	}
	return Allowed
}

// CheckAction applies the fixed rank rules for personal actions. Pass an
// empty target for resource actions and a profile ID when lifting a ban.
func (p Policy) CheckAction(actor, target Subject, scope Scope, id string, lifting bool, now int64) Decision {
	result := p.CheckGrant(actor, scope, id, now)
	if result != Allowed {
		return result
	}
	entry := permissions[id]
	if lifting {
		if !entry.Lift || target.ID == "" {
			return InvalidAction
		}
		return Allowed
	}
	rank := entry.Rank
	if id == "channel.access.edit" && target.ID != "" {
		rank = "critical"
	}
	switch rank {
	case "critical", "important":
		if !target.Active || target.ID == "" {
			return Inactive
		}
		actorRank, targetRank := p.rank(actor), p.rank(target)
		if actorRank < targetRank || rank == "critical" && actorRank == targetRank {
			return HierarchyDenied
		}
	}
	return Allowed
}
