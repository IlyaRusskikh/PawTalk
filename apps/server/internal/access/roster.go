package access

import (
	"context"
	"database/sql"
	"maps"
	"slices"
)

const protectedRosterPageSize = 64

type RosterRole struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
	Icon string `json:"icon,omitempty"`
}

type RosterMember struct {
	Presence        string              `json:"presence,omitempty"`
	ID              string              `json:"id"`
	Name            string              `json:"name,omitempty"`
	LegacyAvatar    *RosterLegacyAvatar `json:"legacyAvatar,omitempty"`
	ProfileAvatar   *ProfileAvatarView  `json:"profileAvatar,omitempty"`
	Owner           bool                `json:"owner,omitempty"`
	Roles           []RosterRole        `json:"roles"`
	Color           string              `json:"color,omitempty"`
	GroupID         string              `json:"groupId,omitempty"`
	GroupRank       int                 `json:"groupRank,omitempty"`
	CanKick         bool                `json:"canKick,omitempty"`
	CanBan          bool                `json:"canBan,omitempty"`
	CanAssignRoles  bool                `json:"canAssignRoles,omitempty"`
	CanEditNickname bool                `json:"canEditNickname,omitempty"`
}

type RosterLegacyAvatar struct {
	Envelope []byte `json:"envelope"`
	Author   string `json:"author"`
}

type RosterPage struct {
	Revision       int64                 `json:"revision"`
	NicknameDigest string                `json:"nicknameDigest,omitempty"`
	ChannelID      string                `json:"channelId,omitempty"`
	Members        []RosterMember        `json:"members"`
	Next           string                `json:"next,omitempty"`
	Mentions       *RosterMentionOptions `json:"mentions,omitempty"`
	RoleColors     map[string]string     `json:"roleColors,omitempty"`
}

type RosterMentionOptions struct {
	Available bool     `json:"available"`
	Mass      bool     `json:"mass"`
	Roles     []string `json:"roles"`
}

// DispatchRoster always uses the current policy, even when continuing a page.
// A channel roster only exposes roles actually assigned within its scope.
func (s *Store) DispatchRoster(ctx context.Context, resolve ResolveSession, channel, after string, revision int64,
	deliver func(SessionQuery, RosterPage) error) error {
	return s.dispatchRoster(ctx, resolve, channel, after, revision, false, "", deliver)
}

func (s *Store) DispatchRosterWithAvatars(ctx context.Context, resolve ResolveSession, channel, after string, revision int64, avatars string,
	deliver func(SessionQuery, RosterPage) error) error {
	return s.dispatchRoster(ctx, resolve, channel, after, revision, false, avatars, deliver)
}

func (s *Store) DispatchMentionRoster(ctx context.Context, resolve ResolveSession, channel, after string, revision int64,
	deliver func(SessionQuery, RosterPage) error) error {
	if channel == "" {
		return InvalidAction
	}
	return s.dispatchRoster(ctx, resolve, channel, after, revision, true, "", deliver)
}

func (s *Store) DispatchVoiceRoster(ctx context.Context, resolve ResolveSession, after string, revision int64, avatars string,
	deliver func(SessionQuery, RosterPage) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.canUseDevice(actor) {
			return ChannelRestricted
		}
		var current int64
		if err := conn.QueryRowContext(ctx, "SELECT revision FROM protected_policy WHERE id=1").Scan(&current); err != nil {
			return err
		}
		if revision != 0 && revision != current {
			return ErrPolicyConflict
		}
		visible, err := project(state, actor.ProfileID, nil)
		if err != nil {
			return err
		}
		if err := state.projectVoiceParticipants(ctx, conn, visible.Channels, s.now().UnixMilli()); err != nil {
			return err
		}
		profiles := make(map[string]bool)
		for _, channel := range visible.Channels {
			if channel.VoiceParticipants != nil {
				for _, participant := range *channel.VoiceParticipants {
					profiles[participant.ProfileID] = true
				}
			}
		}
		page := RosterPage{Revision: current, Members: []RosterMember{}}
		for _, profile := range slices.Sorted(maps.Keys(profiles)) {
			if profile <= after {
				continue
			}
			if len(page.Members) == protectedRosterPageSize {
				page.Next = page.Members[len(page.Members)-1].ID
				break
			}
			member := RosterMember{ID: profile, Owner: profile == state.Owner, Roles: []RosterRole{{ID: Everyone}}}
			if err := attachRosterAvatar(ctx, conn, state, actor, &member, avatars); err != nil {
				return err
			}
			page.Members = append(page.Members, member)
		}
		return deliver(conn, page)
	})
}

func attachRosterAvatar(ctx context.Context, conn *sql.Conn, state State, actor Principal, member *RosterMember, avatars string) error {
	if !(avatars == "all" || avatars == "1" && member.Owner) || !state.canReadCommunityAvatar(actor) {
		return nil
	}
	avatar, err := loadProfileAvatar(ctx, conn, state, actor, member.ID)
	if err != nil {
		return err
	}
	if avatar.Revision > 1 {
		if !member.Owner && avatar.Publisher != nil {
			// The roster verifies the profile's signing key without opening its grants.
			avatar.Publisher.Grants = nil
			avatar.Publisher.GrantSalt = ""
		}
		member.ProfileAvatar = &avatar
	}
	return nil
}

func (s *Store) dispatchRoster(ctx context.Context, resolve ResolveSession, channel, after string, revision int64,
	includeMentions bool, avatars string, deliver func(SessionQuery, RosterPage) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || includeMentions && !state.canUseDevice(actor) {
			return ChannelRestricted
		}
		if channel == "" {
			if result := state.CheckGrant(state.Members[actor.ProfileID], Scope{}, "member.list", 0); result != Allowed {
				return result
			}
		} else if state.Channels[channel].Kind != "text" || !state.CanDeliver(actor.ProfileID, channel, 0) {
			return ChannelRestricted
		}
		var current int64
		if err := conn.QueryRowContext(ctx, "SELECT revision FROM protected_policy WHERE id=1").Scan(&current); err != nil {
			return err
		}
		if revision != 0 && current != revision {
			return ErrPolicyConflict
		}
		page := state.roster(channel, after)
		page.Revision = current
		page.ChannelID = channel
		if !includeMentions {
			digest, err := rosterNicknameDigest(ctx, conn, state, channel)
			if err != nil {
				return err
			}
			page.NicknameDigest = digest
			subject := state.Members[actor.ProfileID]
			now := s.now().UnixMilli()
			for i := range page.Members {
				member := &page.Members[i]
				if err := attachRosterAvatar(ctx, conn, state, actor, member, avatars); err != nil {
					return err
				}
				member.CanEditNickname = nicknameAuthority(state, actor, member.ID, channel, now) == Allowed
				if member.Owner || member.ID == actor.ProfileID {
					continue
				}
				target := state.Members[member.ID]
				member.CanKick = state.CheckAction(subject, target, Scope{}, KickPolicyMember, false, now) == Allowed
				member.CanBan = state.CheckAction(subject, target, Scope{}, BanPolicyMember, false, now) == Allowed
				member.CanAssignRoles = state.CheckAction(subject, target, Scope{}, "role.assign", false, now) == Allowed
			}
		}
		if includeMentions {
			subject := state.Members[actor.ProfileID]
			timeout, err := readTimeout(ctx, conn, subject)
			if err != nil {
				return err
			}
			subject.TimeoutUntil = timeout.Deadline
			page.Mentions = state.rosterMentionOptions(subject, state.scope(state.Channels[channel]), s.now().UnixMilli(), page.Members)
			if !page.Mentions.Available {
				page.Members = []RosterMember{}
				page.Next = ""
				page.RoleColors = nil
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(conn, page)
	})
}

func (s State) rosterMentionOptions(actor Subject, scope Scope, now int64, members []RosterMember) *RosterMentionOptions {
	options := &RosterMentionOptions{Roles: []string{}}
	if s.CheckGrant(actor, scope, "message.send", now) != Allowed {
		return options
	}
	options.Available = true
	options.Mass = s.CheckGrant(actor, scope, "mention.mass", now) == Allowed
	anyRole := s.CheckGrant(actor, scope, "mention.any-role", now) == Allowed
	seen := make(map[string]bool)
	for _, member := range members {
		for _, role := range member.Roles {
			if !seen[role.ID] && (MentionTarget{Kind: "role", ID: role.ID}).valid() &&
				(anyRole || s.RolePresentation[role.ID].Mentionable) {
				options.Roles = append(options.Roles, role.ID)
				seen[role.ID] = true
			}
		}
	}
	return options
}

func (s State) roster(channel, after string) RosterPage {
	page := RosterPage{Members: make([]RosterMember, 0, protectedRosterPageSize)}
	roleOrder := slices.Clone(s.Order)
	slices.Reverse(roleOrder)
	roleOrder = append(roleOrder, Everyone)
	roleRanks := make(map[string]int, len(roleOrder))
	for index, role := range roleOrder {
		roleRanks[role] = index
	}
	groups := make(map[string]bool)
	if channel != "" {
		page.RoleColors = make(map[string]string)
	}
	for _, profile := range slices.Sorted(maps.Keys(s.Members)) {
		subject := s.Members[profile]
		if !subject.Active || (channel != "" && !s.CanDeliver(profile, channel, 0)) {
			continue
		}
		assigned := grantSet(subject.Roles)
		assigned[Everyone] = true
		if page.RoleColors != nil {
			for id := range assigned {
				if color := s.RolePresentation[id].Color; color != "" {
					page.RoleColors[id] = color
				}
			}
		}
		ids := slices.Collect(maps.Keys(assigned))
		slices.SortFunc(ids, func(a, b string) int { return roleRanks[a] - roleRanks[b] })
		appendMember := profile > after && len(page.Members) < protectedRosterPageSize
		member := RosterMember{ID: profile, Owner: profile == s.Owner}
		if appendMember {
			member.Roles = make([]RosterRole, 0, len(ids))
		}
		for _, id := range ids {
			role := s.RolePresentation[id]
			if member.Color == "" {
				member.Color = role.Color
			}
			if member.GroupID == "" && role.Hoist {
				member.GroupID = id
				groups[id] = true
			}
			if appendMember {
				member.Roles = append(member.Roles, RosterRole{ID: id, Name: role.Name, Icon: role.Icon})
			} else if member.GroupID != "" {
				break
			}
		}
		if profile <= after {
			continue
		}
		if appendMember {
			page.Members = append(page.Members, member)
		} else {
			page.Next = page.Members[len(page.Members)-1].ID
		}
	}
	// Only represented groups contribute to rank, so gaps do not disclose
	// other roles. The rank is stable across pages at the pinned revision.
	ranks := make(map[string]int, len(groups))
	for _, id := range roleOrder {
		if groups[id] {
			ranks[id] = len(ranks) + 1
		}
	}
	for i := range page.Members {
		page.Members[i].GroupRank = ranks[page.Members[i].GroupID]
	}
	return page
}
