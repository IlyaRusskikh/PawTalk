package access

import (
	"context"
	"database/sql"
	"errors"
)

var ErrVoiceOccupied = errors.New("protected profile already has a voice slot")
var ErrVoiceFull = errors.New("protected voice channel is full")
var ErrVoiceSlotLost = errors.New("protected voice slot is no longer active")
var ErrVoiceGrantChanged = errors.New("protected voice grant changed")

type VoiceAdmission struct {
	CanSpeak      bool
	CanReceive    bool
	CanReceiveKey bool
	Capacity      uint32
}

type VoiceRestriction struct {
	Muted         bool
	Deafened      bool
	MediaDeafened bool `json:",omitempty"`
}

const serverVoiceRestriction = "*"

func (s State) effectiveVoiceRestriction(channel, profile string) VoiceRestriction {
	local, global := s.VoiceRestrictions[channel][profile], s.VoiceRestrictions[serverVoiceRestriction][profile]
	return VoiceRestriction{Muted: local.Muted || global.Muted, Deafened: local.Deafened || global.Deafened || global.MediaDeafened}
}

func (s State) excludedFromVoiceKeys(channel, profile string) bool {
	return s.VoiceRestrictions[channel][profile].Deafened || s.VoiceRestrictions[serverVoiceRestriction][profile].Deafened
}

type VoiceControlTarget struct {
	ChannelID string
	ProfileID string
}

func (s State) projectVoiceParticipants(ctx context.Context, query *sql.Conn, channels []VisibleChannel, now int64) error {
	visible := make(map[string]*VisibleChannel)
	for i := range channels {
		if channels[i].Kind == "voice" {
			participants := []VisibleVoiceParticipant{}
			channels[i].VoiceParticipants = &participants
			visible[channels[i].ID] = &channels[i]
		}
	}
	if len(visible) == 0 {
		return nil
	}
	rows, err := query.QueryContext(ctx, `SELECT slot.channel_id,slot.profile_id,slot.device_id,slot.session_id
		FROM protected_voice_slots slot JOIN protected_runtime_sessions session
		ON session.session_id=slot.session_id AND session.device_id=slot.device_id
		LEFT JOIN protected_timeouts timeout ON timeout.profile_id=slot.profile_id
		WHERE slot.active_until>? AND slot.grant_until>0 AND slot.disconnect_pending=0
		AND session.expires_at>? AND COALESCE(timeout.deadline,0)<=?
		ORDER BY slot.channel_id,slot.profile_id`, now, now, now)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, session string
		var actor Principal
		if err := rows.Scan(&id, &actor.ProfileID, &actor.DeviceID, &session); err != nil {
			return err
		}
		channel := visible[id]
		if channel == nil {
			continue
		}
		if _, err := s.voiceAdmission(actor, id, now); err == nil {
			restriction := s.effectiveVoiceRestriction(id, actor.ProfileID)
			global := s.VoiceRestrictions[serverVoiceRestriction][actor.ProfileID]
			*channel.VoiceParticipants = append(*channel.VoiceParticipants, VisibleVoiceParticipant{
				ProfileID: actor.ProfileID, SessionID: session, Muted: restriction.Muted, Deafened: restriction.Deafened,
				ServerMuted: global.Muted, ServerDeafened: global.Deafened || global.MediaDeafened,
			})
		}
	}
	return rows.Err()
}

func VoiceTelemetryPeers(ctx context.Context, tx *sql.Tx, actor Principal, session, channel string, now int64) ([]string, error) {
	target, err := readLiveVoiceTargetSession(ctx, tx, channel, session, now)
	if err != nil {
		return nil, err
	}
	if target != actor {
		return nil, ChannelRestricted
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return nil, err
	}
	if _, err := state.voiceAdmissionWithTimeout(ctx, tx, actor, channel, now); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT slot.session_id,slot.profile_id,slot.device_id FROM protected_voice_slots slot
		JOIN protected_runtime_sessions live ON live.session_id=slot.session_id AND live.device_id=slot.device_id
		LEFT JOIN protected_timeouts timeout ON timeout.profile_id=slot.profile_id
		WHERE slot.channel_id=? AND slot.session_id<>? AND slot.active_until>? AND slot.grant_until>0
		AND slot.disconnect_pending=0 AND live.expires_at>? AND COALESCE(timeout.deadline,0)<=?`, channel, session, now, now, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var peers []string
	for rows.Next() {
		var peer string
		var participant Principal
		if err := rows.Scan(&peer, &participant.ProfileID, &participant.DeviceID); err != nil {
			return nil, err
		}
		if _, err := state.voiceAdmission(participant, channel, now); err == nil {
			peers = append(peers, peer)
		}
	}
	return peers, rows.Err()
}

func (s State) invalidateVoiceGrants(ctx context.Context, tx *sql.Tx, now int64) error {
	rows, err := tx.QueryContext(ctx, `SELECT channel_id,profile_id,device_id,can_speak,can_receive,grant_capacity
		FROM protected_voice_slots WHERE active_until>? AND grant_digest<>''`, now)
	if err != nil {
		return err
	}
	defer rows.Close()
	var invalid []VoiceControlTarget
	for rows.Next() {
		var channel string
		var actor Principal
		var speak, receive bool
		var capacity uint32
		if err := rows.Scan(&channel, &actor.ProfileID, &actor.DeviceID, &speak, &receive, &capacity); err != nil {
			return err
		}
		wanted, err := s.voiceAdmission(actor, channel, now)
		if err != nil || wanted.CanSpeak != speak || wanted.CanReceive != receive || wanted.Capacity != capacity {
			invalid = append(invalid, VoiceControlTarget{channel, actor.ProfileID})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, slot := range invalid {
		if _, err := tx.ExecContext(ctx, "UPDATE protected_voice_slots SET grant_digest='' WHERE channel_id=? AND profile_id=?",
			slot.ChannelID, slot.ProfileID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) PendingVoiceControls(ctx context.Context) ([]VoiceControlTarget, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT channel_id,profile_id FROM protected_voice_slots
		WHERE disconnect_pending=1 OR (active_until>0 AND (active_until<=? OR reconcile_pending=1))
		ORDER BY active_until,channel_id,profile_id LIMIT 16`, s.now().UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pending []VoiceControlTarget
	for rows.Next() {
		var target VoiceControlTarget
		if err := rows.Scan(&target.ChannelID, &target.ProfileID); err != nil {
			return nil, err
		}
		pending = append(pending, target)
	}
	return pending, rows.Err()
}

func (s *State) changeVoiceRestriction(actor, channelID, target, action string, lift, serverWide, mediaOnly, exactSession bool) error {
	channel, exists := s.Channels[channelID]
	if !exists || channel.Kind != "voice" {
		return ChannelRestricted
	}
	if result := s.voiceRestrictionAuthority(actor, target, channelID, action, lift, exactSession, 0); result != Allowed {
		return result
	}
	if serverWide {
		if !s.canChangeServerVoiceRestriction(actor, target, lift) {
			return HierarchyDenied
		}
		channelID = serverVoiceRestriction
	}
	restriction := s.VoiceRestrictions[channelID][target]
	if action == ChangeVoiceMute {
		restriction.Muted = !lift
	} else if lift {
		restriction.Deafened = false
		restriction.MediaDeafened = false
	} else if mediaOnly {
		restriction.MediaDeafened = true
	} else {
		restriction.Deafened = true
	}
	if restriction == (VoiceRestriction{}) {
		delete(s.VoiceRestrictions[channelID], target)
		if len(s.VoiceRestrictions[channelID]) == 0 {
			delete(s.VoiceRestrictions, channelID)
		}
		return nil
	}
	if s.VoiceRestrictions == nil {
		s.VoiceRestrictions = make(map[string]map[string]VoiceRestriction)
	}
	if s.VoiceRestrictions[channelID] == nil {
		s.VoiceRestrictions[channelID] = make(map[string]VoiceRestriction)
	}
	s.VoiceRestrictions[channelID][target] = restriction
	return nil
}

func (s State) voiceRestrictionAuthority(actor, target, channel, action string, lift, exactSession bool, now int64) Decision {
	if exactSession && target == s.Owner && s.Members[target].Active &&
		(actor != target || lift) && s.CheckGrant(s.Members[actor], Scope{}, Administrator, now) == Allowed {
		return s.CheckGrant(s.Members[actor], s.scope(s.Channels[channel]), action, now)
	}
	return s.CheckAction(s.Members[actor], s.Members[target], s.scope(s.Channels[channel]), action, lift, now)
}

func (s State) canChangeServerVoiceRestriction(actor, target string, lift bool) bool {
	moderator, subject := s.Members[actor], s.Members[target]
	return subject.Active && s.CheckGrant(moderator, Scope{}, Administrator, 0) == Allowed &&
		(actor == target && lift || actor != target && (target == s.Owner || s.rank(moderator) > s.rank(subject)))
}

func checkVoiceAdmission(ctx context.Context, tx *sql.Tx, actor Principal, channelID string, now int64) (VoiceAdmission, error) {
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return VoiceAdmission{}, err
	}
	return state.voiceAdmissionWithTimeout(ctx, tx, actor, channelID, now)
}

func (s State) voiceAdmissionWithTimeout(ctx context.Context, tx *sql.Tx, actor Principal, channelID string, now int64) (VoiceAdmission, error) {
	profile := s.Members[actor.ProfileID]
	timeout, err := readTimeout(ctx, tx, profile)
	if err != nil {
		return VoiceAdmission{}, err
	}
	profile.TimeoutUntil = timeout.Deadline
	return s.voiceAdmissionFor(actor, profile, channelID, now)
}

func (s State) voiceAdmission(actor Principal, channelID string, now int64) (VoiceAdmission, error) {
	return s.voiceAdmissionFor(actor, s.Members[actor.ProfileID], channelID, now)
}

func (s State) voiceAdmissionFor(actor Principal, profile Subject, channelID string, now int64) (VoiceAdmission, error) {
	channel, exists := s.Channels[channelID]
	if !s.PolicyAnchored || !exists || channel.Kind != "voice" || !s.hasPolicyDevice(actor) {
		return VoiceAdmission{}, ChannelRestricted
	}
	scope := s.scope(channel)
	if result := s.CheckGrant(profile, scope, "voice.connect", now); result != Allowed {
		return VoiceAdmission{}, result
	}
	restriction := s.effectiveVoiceRestriction(channelID, actor.ProfileID)
	admission := VoiceAdmission{
		CanSpeak:      !restriction.Muted && !restriction.Deafened && s.CheckGrant(profile, scope, "voice.speak", now) == Allowed,
		CanReceive:    !restriction.Deafened,
		CanReceiveKey: !s.excludedFromVoiceKeys(channelID, actor.ProfileID),
	}
	if channel.Settings != nil {
		admission.Capacity = channel.Settings.VoiceCapacity
	}
	return admission, nil
}

// ReserveVoice runs under the membership write transaction. Every token that
// may still be used occupies a slot, even after the app requests a leave.
func ReserveVoice(ctx context.Context, tx *sql.Tx, actor Principal, session, channel string, now, activeUntil, grantUntil int64) (VoiceAdmission, error) {
	return reserveVoice(ctx, tx, actor, session, channel, now, activeUntil, grantUntil, false)
}

func ReserveRuntimeVoice(ctx context.Context, tx *sql.Tx, actor Principal, session, channel string, now, activeUntil, grantUntil int64) (VoiceAdmission, error) {
	return reserveVoice(ctx, tx, actor, session, channel, now, activeUntil, grantUntil, true)
}

func reserveVoice(ctx context.Context, tx *sql.Tx, actor Principal, session, channel string, now, activeUntil, grantUntil int64,
	allowParkedReplacement bool) (VoiceAdmission, error) {
	admission, err := checkVoiceAdmission(ctx, tx, actor, channel, now)
	if err != nil {
		return VoiceAdmission{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM protected_voice_slots WHERE disconnect_pending=0
		AND ((active_until=0 AND grant_until<=?) OR (grant_until=0 AND active_until<=?))`, now, now); err != nil {
		return VoiceAdmission{}, err
	}
	var held bool
	// Reopening an already disconnected device while deafened cannot revive an
	// old grant. Its digest was cleared before the media slot was retired.
	replaceRetired := allowParkedReplacement && !admission.CanReceiveKey
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_voice_slots
		WHERE profile_id=? AND ((active_until>0 AND (session_id<>? OR channel_id<>?))
		OR (grant_until>? AND channel_id=? AND session_id<>?
			AND NOT (? AND device_id=? AND active_until=0 AND grant_digest='' AND disconnect_pending=0))
		OR (channel_id=? AND (disconnect_pending=1 OR (active_until>0 AND active_until<=?)))))`,
		actor.ProfileID, session, channel, now, channel, session, replaceRetired, actor.DeviceID, channel, now).Scan(&held)
	if err != nil {
		return VoiceAdmission{}, err
	}
	if held {
		return VoiceAdmission{}, ErrVoiceOccupied
	}
	if err := checkVoiceCapacity(ctx, tx, admission.Capacity, channel, actor.ProfileID, now); err != nil {
		return VoiceAdmission{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_voice_slots
		(channel_id,profile_id,session_id,device_id,active_until,grant_until,can_speak,can_receive) VALUES(?,?,?,?,?,?,?,?)
		ON CONFLICT(channel_id,profile_id) DO UPDATE SET active_until=excluded.active_until,
		grant_until=MAX(protected_voice_slots.grant_until,excluded.grant_until),can_speak=excluded.can_speak,
		can_receive=excluded.can_receive,session_id=excluded.session_id,device_id=excluded.device_id`,
		channel, actor.ProfileID, session, actor.DeviceID, activeUntil, grantUntil, admission.CanSpeak, admission.CanReceive)
	if err != nil {
		return VoiceAdmission{}, err
	}
	_, err = tx.ExecContext(ctx, "DELETE FROM protected_voice_moves WHERE profile_id=? AND session_id=? AND ready=1",
		actor.ProfileID, session)
	return admission, err
}

func checkVoiceCapacity(ctx context.Context, tx *sql.Tx, capacity uint32, channel, profile string, now int64) error {
	if capacity == 0 {
		return nil
	}
	var occupied uint32
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM (
		SELECT profile_id FROM protected_voice_slots WHERE channel_id=? AND profile_id<>?
			AND (active_until>0 OR grant_until>? OR disconnect_pending=1)
		UNION SELECT profile_id FROM protected_voice_moves WHERE destination=? AND profile_id<>? AND expires_at>?
	)`, channel, profile, now, channel, profile, now).Scan(&occupied)
	if err != nil {
		return err
	}
	if occupied >= capacity {
		return ErrVoiceFull
	}
	return nil
}

func RecordVoiceGrant(ctx context.Context, tx *sql.Tx, channel, profile, session, digest string, capacity uint32) error {
	result, err := tx.ExecContext(ctx, "UPDATE protected_voice_slots SET grant_digest=?,grant_capacity=? WHERE channel_id=? AND profile_id=? AND session_id=?",
		digest, capacity, channel, profile, session)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count != 1 {
		return ErrVoiceSlotLost
	}
	return err
}

func ValidateVoiceSignal(ctx context.Context, tx *sql.Tx, actor Principal, channel, session, digest string, speak, receive bool, now int64) error {
	var stored string
	var capacity uint32
	err := tx.QueryRowContext(ctx, `SELECT grant_digest,grant_capacity FROM protected_voice_slots
		WHERE channel_id=? AND profile_id=? AND session_id=? AND device_id=? AND active_until>? AND grant_until>?`,
		channel, actor.ProfileID, session, actor.DeviceID, now, now).Scan(&stored, &capacity)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrVoiceSlotLost
	}
	if err != nil {
		return err
	}
	if stored != digest {
		return ErrVoiceGrantChanged
	}
	wanted, err := checkVoiceAdmission(ctx, tx, actor, channel, now)
	if err != nil {
		return err
	}
	if wanted.CanSpeak != speak || wanted.CanReceive != receive || wanted.Capacity != capacity {
		return ErrVoiceGrantChanged
	}
	return nil
}

// ReconcileVoice updates a connected participant from the current policy.
// Applied permissions change only after the media server acknowledges. Keep
// the transaction open so a concurrent restriction cannot be overwritten by
// a grant calculated from a superseded policy.
func ReconcileVoice(ctx context.Context, tx *sql.Tx, channel, profile string, now int64,
	apply func(session string, admission *VoiceAdmission) error) error {
	var session, device string
	var pending, disconnect bool
	var activeUntil int64
	err := tx.QueryRowContext(ctx, `SELECT session_id,device_id,reconcile_pending,disconnect_pending,active_until FROM protected_voice_slots
		WHERE channel_id=? AND profile_id=? AND (active_until>0 OR disconnect_pending=1)`,
		channel, profile).Scan(&session, &device, &pending, &disconnect, &activeUntil)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	remove := func() error {
		if err := apply(session, nil); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE protected_voice_slots SET active_until=0,grant_digest='',
			reconcile_pending=0,disconnect_pending=0 WHERE channel_id=? AND profile_id=?`,
			channel, profile)
		return err
	}
	if disconnect || activeUntil <= now {
		return remove()
	}
	if !pending {
		return nil
	}
	wanted, err := checkVoiceAdmission(ctx, tx, Principal{ProfileID: profile, DeviceID: device}, channel, now)
	if err != nil {
		var denied Decision
		if !errors.As(err, &denied) {
			return err
		}
		return remove()
	}
	if err := apply(session, &wanted); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE protected_voice_slots SET can_speak=?,can_receive=?,reconcile_pending=0 WHERE channel_id=? AND profile_id=?",
		wanted.CanSpeak, wanted.CanReceive, channel, profile)
	return err
}

func RefreshVoice(ctx context.Context, tx *sql.Tx, actor Principal, session string, now, activeUntil int64) error {
	var channel string
	var speak, receive bool
	err := tx.QueryRowContext(ctx, `SELECT channel_id,can_speak,can_receive FROM protected_voice_slots
		WHERE profile_id=? AND session_id=? AND active_until>?`, actor.ProfileID, session, now).Scan(&channel, &speak, &receive)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrVoiceSlotLost
	}
	if err != nil {
		return err
	}
	admission, err := checkVoiceAdmission(ctx, tx, actor, channel, now)
	if err != nil {
		return err
	}
	if admission.CanSpeak != speak || admission.CanReceive != receive {
		return ErrVoiceGrantChanged
	}
	_, err = tx.ExecContext(ctx, `UPDATE protected_voice_slots SET active_until=?
		WHERE channel_id=? AND profile_id=? AND session_id=?`, activeUntil, channel, actor.ProfileID, session)
	return err
}

// RefreshRuntimeVoiceLease allows a deafened participant to remain in the
// room without authorizing key delivery. Only an existing media grant can
// keep a suspended slot alive.
func RefreshRuntimeVoiceLease(ctx context.Context, tx *sql.Tx, actor Principal, session, channel string, now, activeUntil int64) (bool, error) {
	var speak, receive bool
	var grantUntil int64
	err := tx.QueryRowContext(ctx, `SELECT can_speak,can_receive,grant_until FROM protected_voice_slots
		WHERE channel_id=? AND profile_id=? AND session_id=? AND device_id=? AND active_until>? AND disconnect_pending=0`,
		channel, actor.ProfileID, session, actor.DeviceID, now).Scan(&speak, &receive, &grantUntil)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrVoiceSlotLost
	}
	if err != nil {
		return false, err
	}
	admission, err := checkVoiceAdmission(ctx, tx, actor, channel, now)
	if err != nil {
		return false, err
	}
	deafened := !admission.CanReceiveKey
	if deafened && grantUntil == 0 {
		return false, ChannelRestricted
	}
	if !deafened && (admission.CanSpeak != speak || admission.CanReceive != receive) {
		return false, ErrVoiceGrantChanged
	}
	_, err = tx.ExecContext(ctx, `UPDATE protected_voice_slots SET active_until=?
		WHERE channel_id=? AND profile_id=? AND session_id=?`, activeUntil, channel, actor.ProfileID, session)
	return deafened, err
}

func AuthorizeDeafenedVoiceGrant(ctx context.Context, tx *sql.Tx, actor Principal, session, channel string, now int64) error {
	admission, err := checkVoiceAdmission(ctx, tx, actor, channel, now)
	if err != nil {
		return err
	}
	if admission.CanReceiveKey || admission.CanSpeak {
		return ErrVoiceGrantChanged
	}
	var reserved bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_voice_slots
		WHERE channel_id=? AND profile_id=? AND session_id=? AND device_id=? AND active_until>? AND disconnect_pending=0)`,
		channel, actor.ProfileID, session, actor.DeviceID, now).Scan(&reserved); err != nil {
		return err
	}
	if !reserved {
		return ErrVoiceSlotLost
	}
	return nil
}

func ReleaseVoice(ctx context.Context, tx *sql.Tx, actor Principal, session string) (string, error) {
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_voice_moves WHERE profile_id=? AND session_id=?", actor.ProfileID, session); err != nil {
		return "", err
	}
	var channel string
	err := tx.QueryRowContext(ctx, `UPDATE protected_voice_slots SET active_until=0,grant_digest='',reconcile_pending=0,disconnect_pending=(grant_until>0)
		WHERE profile_id=? AND session_id=? AND active_until>0 RETURNING channel_id`,
		actor.ProfileID, session).Scan(&channel)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return channel, err
}
