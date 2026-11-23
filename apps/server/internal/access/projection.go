package access

import (
	"context"
	"database/sql"
)

type VisibleChannel struct {
	ID                string
	Kind              string
	CategoryID        string
	Settings          *ChannelSettings           `json:",omitempty"`
	ImportedName      string                     `json:",omitempty"`
	CanOrder          bool                       `json:",omitempty"`
	CanEditSettings   bool                       `json:",omitempty"`
	CanInspectACL     bool                       `json:",omitempty"`
	KeysPending       bool                       `json:",omitempty"`
	VoiceParticipants *[]VisibleVoiceParticipant `json:"voiceParticipants,omitempty"`
}

type VisibleVoiceParticipant struct {
	ProfileID      string `json:"profileId"`
	SessionID      string `json:"sessionId"`
	Name           string `json:"name,omitempty"`
	Muted          bool   `json:"muted,omitempty"`
	Deafened       bool   `json:"deafened,omitempty"`
	ServerMuted    bool   `json:"serverMuted,omitempty"`
	ServerDeafened bool   `json:"serverDeafened,omitempty"`
	SelfMuted      bool   `json:"selfMuted,omitempty"`
	SelfDeafened   bool   `json:"selfDeafened,omitempty"`
}

type ScopedEvent struct {
	ChannelID        string
	ProfileID        string
	SenderProfileID  string
	OriginalPosition uint64
	Content          bool
	Payload          []byte
}

type VisibleCategory struct {
	ID   string
	Name string `json:",omitempty"`
}

type RotationQueueSummary struct {
	Waiting    int `json:"waiting"`
	Processing int `json:"processing"`
}

type Projection struct {
	Channels                []VisibleChannel
	Events                  []ScopedEvent
	OwnerProfileID          string                `json:",omitempty"`
	PolicyRevision          int64                 `json:",omitempty"`
	Categories              []VisibleCategory     `json:",omitempty"`
	ManagedCategories       []VisibleCategory     `json:",omitempty"`
	CanListMembers          bool                  `json:",omitempty"`
	CanManageTimeouts       bool                  `json:",omitempty"`
	CanViewAudit            bool                  `json:",omitempty"`
	CanListInvites          bool                  `json:",omitempty"`
	CanManageBans           bool                  `json:",omitempty"`
	CanInspectPolicy        bool                  `json:",omitempty"`
	CanEditRoles            bool                  `json:",omitempty"`
	CanAssignRoles          bool                  `json:",omitempty"`
	CanEditOwnNickname      bool                  `json:",omitempty"`
	CanLiftOwnServerVoice   bool                  `json:",omitempty"`
	CanEditCommunity        bool                  `json:",omitempty"`
	CommunityAvatarRevision int64                 `json:"communityAvatarRevision,omitempty"`
	CommunityAvatarPending  bool                  `json:"communityAvatarPending,omitempty"`
	Timeout                 *TimeoutStatus        `json:",omitempty"`
	RotationQueue           *RotationQueueSummary `json:"rotationQueue,omitempty"`
}

// Project filters one committed snapshot. Use Dispatch for deferred delivery.
func (s *Store) Project(ctx context.Context, profile string, events []ScopedEvent) (Projection, error) {
	state, _, err := s.Snapshot(ctx)
	if err != nil {
		return Projection{}, err
	}
	return project(state, profile, events)
}

// Dispatch authorizes and emits one bounded batch before releasing the policy
// transaction. The writer must set its own short output deadline and must not
// reenter the store.
func (s *Store) Dispatch(ctx context.Context, profile string, events []ScopedEvent, write func(Projection) error) error {
	return s.DispatchSession(ctx, func(context.Context, SessionQuery) (Principal, error) {
		return Principal{ProfileID: profile}, nil
	}, events, write)
}

// DispatchSession revalidates the session inside the delivery lock.
func (s *Store) DispatchSession(ctx context.Context, resolve ResolveSession, events []ScopedEvent, write func(Projection) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(_ *sql.Conn, state State, principal Principal) error {
		result, err := project(state, principal.ProfileID, events)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return write(result)
	})
}

// DispatchVisibleState includes admitted devices that are still waiting for
// their first key packages. It serves metadata and carries no events.
func (s *Store) DispatchVisibleState(ctx context.Context, resolve ResolveSession, write func(Projection) error) error {
	return s.DispatchVisibleEvents(ctx, resolve, nil, write)
}

// DispatchVisibleEvents keeps queued invalidations and the account's current
// state on the same side of a policy commit. A WebSocket writer must be bounded.
func (s *Store) DispatchVisibleEvents(ctx context.Context, resolve ResolveSession, events []ScopedEvent, write func(Projection) error) error {
	return s.dispatchVisible(ctx, resolve, events, func(_ SessionQuery, result Projection) error { return write(result) })
}

// DispatchVisibleStateWithQuery lets callers include server metadata from the same read.
func (s *Store) DispatchVisibleStateWithQuery(ctx context.Context, resolve ResolveSession, write func(SessionQuery, Projection) error) error {
	return s.dispatchVisible(ctx, resolve, nil, write)
}

func (s *Store) dispatchVisible(ctx context.Context, resolve ResolveSession, events []ScopedEvent, write func(SessionQuery, Projection) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) {
			return ChannelRestricted
		}
		if _, err := applyChannelLayout(ctx, conn, &state); err != nil {
			return err
		}
		result, err := project(state, actor.ProfileID, events)
		if err != nil {
			return err
		}
		result.CanListMembers = state.CheckGrant(state.Members[actor.ProfileID], Scope{}, "member.list", 0) == Allowed
		now := s.now().UnixMilli()
		if state.canUseDevice(actor) {
			if err := state.projectVoiceParticipants(ctx, conn, result.Channels, now); err != nil {
				return err
			}
		}
		subject := state.Members[actor.ProfileID]
		result.CanEditOwnNickname = state.CheckGrant(subject, Scope{}, EditOwnNickname, now) == Allowed
		result.CanLiftOwnServerVoice = state.CheckGrant(subject, Scope{}, Administrator, now) == Allowed
		result.CanEditCommunity = state.CheckGrant(subject, Scope{}, editCommunity, now) == Allowed
		head, err := readPolicyHead(ctx, conn)
		if err != nil {
			return err
		}
		result.OwnerProfileID, result.PolicyRevision = state.Owner, head.Draft.Revision
		if head.Draft.TextProjectionVersion == ProfileRoleAuthorityProjectionVersion && state.canReadCommunityAvatar(actor) {
			if err := conn.QueryRowContext(ctx, `SELECT a.revision,a.body IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM protected_community_avatar_packages p WHERE p.device_id=? AND p.agreement_key=?) FROM protected_community_avatar a WHERE a.id=1`,
				actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey).Scan(&result.CommunityAvatarRevision, &result.CommunityAvatarPending); err != nil {
				return err
			}
		}
		queue, err := visibleRotationQueue(ctx, conn, result.Channels, result.PolicyRevision, now)
		if err != nil {
			return err
		}
		result.RotationQueue = &queue
		if head.Draft.TextProjectionVersion >= TextOrderAuthorityVersion {
			for i := range result.Channels {
				channel := state.Channels[result.Channels[i].ID]
				canEdit := state.CheckGrant(subject, state.scope(channel), "channel.edit", 0) == Allowed
				result.Channels[i].CanOrder = canEdit
				result.Channels[i].CanEditSettings = canEdit && head.Draft.TextProjectionVersion >= ChannelSettingsProjectionVersion
				result.Channels[i].CanInspectACL = head.Draft.TextProjectionVersion >= ChannelACLProjectionVersion &&
					state.CheckGrant(subject, state.scope(channel), channelACLPermission, 0) == Allowed
			}
		}
		result.CanViewAudit, _ = auditPrivilege(state, actor, now)
		invites := state.inviteGrants(actor, now)
		result.CanListInvites = invites.own || invites.viewAll
		result.CanManageBans = state.CheckGrant(subject, Scope{}, BanPolicyMember, now) == Allowed
		result.CanInspectPolicy = state.canInspectFullPolicy(actor)
		if result.CanInspectPolicy || state.Owner == actor.ProfileID {
			for _, id := range orderedResources(state.CategoryOrder, state.Categories) {
				result.ManagedCategories = append(result.ManagedCategories, VisibleCategory{ID: id, Name: state.CategoryNames[id]})
			}
		}
		result.CanEditRoles = state.CheckGrant(subject, Scope{}, "role.edit", now) == Allowed
		result.CanAssignRoles = state.CheckGrant(subject, Scope{}, "role.assign", now) == Allowed
		var runtimeDevice bool
		if err := conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_invite_admissions WHERE device_id=?) OR
			NOT EXISTS(SELECT 1 FROM devices WHERE device_id=?)`, actor.DeviceID, actor.DeviceID).
			Scan(&runtimeDevice); err != nil {
			return err
		}
		if runtimeDevice {
			for i := range result.Channels {
				channel := &result.Channels[i]
				channel.KeysPending, err = state.channelKeysPending(ctx, conn, actor, channel.ID, now)
				if err != nil {
					return err
				}
			}
		}
		result.CanManageTimeouts = state.CheckGrant(subject, Scope{}, "member.timeout", now) == Allowed
		timeout, err := readTimeout(ctx, conn, subject)
		if err != nil {
			return err
		}
		if timeout.Deadline > now {
			timeout.CanLift = result.CanManageTimeouts
			result.Timeout = &timeout
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return write(conn, result)
	})
}

func visibleRotationQueue(ctx context.Context, conn *sql.Conn, channels []VisibleChannel, revision, now int64) (RotationQueueSummary, error) {
	var summary RotationQueueSummary
	if len(channels) == 0 {
		return summary, nil
	}
	visible := make(map[string]bool, len(channels))
	for _, channel := range channels {
		visible[channel.ID] = true
	}
	rows, err := conn.QueryContext(ctx, `SELECT channel_id, lease_until>? AND lease_device<>'' AND lease_id<>''
		FROM protected_rotation_tasks WHERE revision=?`, now, revision)
	if err != nil {
		return summary, err
	}
	defer rows.Close()
	// The queue has one row per channel and purpose, regardless of recipient
	// count, retries, executor priority, or source package availability.
	for rows.Next() {
		var channel string
		var processing bool
		if err := rows.Scan(&channel, &processing); err != nil {
			return summary, err
		}
		if !visible[channel] {
			continue
		}
		if processing {
			summary.Processing++
		} else {
			summary.Waiting++
		}
	}
	return summary, rows.Err()
}

func (s State) channelKeysPending(ctx context.Context, query SessionQuery, actor Principal, channel string, now int64) (bool, error) {
	for _, purpose := range []string{LiveEpoch, ArchiveEpoch} {
		if !s.canLoadEpoch(actor, channel, purpose) {
			continue
		}
		gen := s.currentGeneration(channel, purpose)
		if gen == 0 || purpose == LiveEpoch && !s.EpochWindows[channel].Accepts(gen, now) {
			return true, nil
		}
		var found bool
		if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_epoch_packages
			WHERE channel_id=? AND purpose=? AND generation=? AND recipient_id=? AND recipient_key=?)`,
			channel, purpose, gen, actor.DeviceID, s.KeyRecipients[actor.DeviceID].PublicKey).Scan(&found); err != nil {
			return false, err
		}
		if !found {
			return true, nil
		}
	}
	return false, nil
}

// DispatchHistory keeps the same delivery lock as event dispatch. The callback
// must query and emit only positions in [first, next) before returning.
func (s *Store) DispatchHistory(ctx context.Context, resolve ResolveSession, channelID string,
	dispatch func(conn *sql.Conn, first, next uint64) error) error {
	return s.dispatchHistory(ctx, resolve, channelID, func(conn *sql.Conn, _ State, _ Principal, first, next uint64) error {
		return dispatch(conn, first, next)
	})
}

func (s *Store) dispatchHistory(ctx context.Context, resolve ResolveSession, channelID string,
	dispatch func(*sql.Conn, State, Principal, uint64, uint64) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, principal Principal) error {
		channel, exists := state.Channels[channelID]
		if !exists || channel.Kind != "text" || !state.CanDeliver(principal.ProfileID, channelID, 0) {
			return MissingGrant
		}
		return dispatch(conn, state, principal, state.firstReadablePosition(channelID, principal.ProfileID), channel.NextPosition)
	})
}

func (state State) firstReadablePosition(channelID, profile string) uint64 {
	channel := state.Channels[channelID]
	first := state.Admissions[channelID][profile].FirstPosition
	if first == 0 {
		return channel.NextPosition
	}
	if state.CheckGrant(state.Members[profile], state.scope(channel), "history.full", 0) == Allowed {
		return 1
	}
	return first
}

func (s *Store) DispatchFullArchive(ctx context.Context, resolve ResolveSession, channelID string, dispatch func(*sql.Conn) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, principal Principal) error {
		if !state.PolicyAnchored || !state.canLoadEpoch(principal, channelID, ArchiveEpoch) ||
			state.Admissions[channelID][principal.ProfileID].FirstPosition == 0 {
			return ChannelRestricted
		}
		return dispatch(conn)
	})
}

func (s *Store) dispatchAuthorized(ctx context.Context, resolve ResolveSession, operation func(*sql.Conn, State, Principal) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, principal Principal) error {
		if !state.canUseDevice(principal) {
			return Inactive
		}
		return operation(conn, state, principal)
	})
}

func (s *Store) dispatchPolicyTransaction(ctx context.Context, resolve ResolveSession,
	operation func(*sql.Conn, State, Principal) error) error {
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Keep the transaction until the bounded writer returns, even if the
	// request is cancelled halfway through the callback.
	defer conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	principal, err := resolve(ctx, conn)
	if err != nil {
		return err
	}
	state, _, err := readState(conn.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return operation(conn, state, principal)
}

func project(state State, profile string, events []ScopedEvent) (Projection, error) {
	if !state.Members[profile].Active {
		return Projection{}, Inactive
	}
	result := Projection{Channels: []VisibleChannel{}, Events: []ScopedEvent{}}
	categories := make(map[string]bool)
	for _, id := range orderedResources(state.ChannelOrder, state.Channels) {
		channel := state.Channels[id]
		if state.CanDeliver(profile, id, 0) {
			result.Channels = append(result.Channels, VisibleChannel{ID: id, Kind: channel.Kind, CategoryID: channel.CategoryID, Settings: channel.Settings})
			if _, exists := state.Categories[channel.CategoryID]; exists {
				categories[channel.CategoryID] = true
			}
		}
	}
	for _, id := range orderedResources(state.CategoryOrder, state.Categories) {
		if categories[id] {
			result.Categories = append(result.Categories, VisibleCategory{ID: id, Name: state.CategoryNames[id]})
		}
	}
	for _, event := range events {
		if event.ProfileID != "" {
			if !state.Members[event.ProfileID].Active {
				continue
			}
			if event.ProfileID == profile || state.CheckGrant(state.Members[profile], Scope{}, "member.list", 0) == Allowed {
				result.Events = append(result.Events, event)
				continue
			}
			for _, channel := range result.Channels {
				if channel.Kind == "text" && state.CanDeliver(event.ProfileID, channel.ID, 0) {
					result.Events = append(result.Events, event)
					break
				}
			}
			continue
		}
		if event.Content != (event.OriginalPosition != 0) {
			continue
		}
		if event.SenderProfileID != "" && (event.SenderProfileID == profile ||
			!state.CanDeliver(event.SenderProfileID, event.ChannelID, 0)) {
			continue
		}
		if state.CanDeliver(profile, event.ChannelID, event.OriginalPosition) {
			result.Events = append(result.Events, event)
		}
	}
	return result, nil
}
