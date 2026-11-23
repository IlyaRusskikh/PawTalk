package access

import (
	"context"
	"database/sql"
	"errors"
)

type VoiceMove struct {
	ProfileID   string
	SessionID   string
	DeviceID    string
	Source      string
	Destination string
	Moderator   Principal
}

func (s State) authorizeVoiceMove(ctx context.Context, tx *sql.Tx, move VoiceMove, now int64) error {
	if err := s.voiceMoveAuthority(move, now); err != nil || move.Destination == "" {
		return err
	}
	admission, err := s.voiceAdmissionWithTimeout(ctx, tx, Principal{ProfileID: move.ProfileID, DeviceID: move.DeviceID}, move.Destination, now)
	if err != nil {
		return err
	}
	var conflictingGrant bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_voice_slots WHERE
		channel_id=? AND profile_id=? AND (active_until>0 OR (session_id<>? AND grant_until>?) OR disconnect_pending=1))`,
		move.Destination, move.ProfileID, move.SessionID, now).Scan(&conflictingGrant); err != nil {
		return err
	}
	if conflictingGrant {
		return ErrVoiceOccupied
	}
	return checkVoiceCapacity(ctx, tx, admission.Capacity, move.Destination, move.ProfileID, now)
}

func (s State) voiceMoveAuthority(move VoiceMove, now int64) error {
	from, exists := s.Channels[move.Source]
	if !s.PolicyAnchored || !exists || from.Kind != "voice" || !s.hasPolicyDevice(move.Moderator) ||
		!s.CanDeliver(move.Moderator.ProfileID, move.Source, 0) {
		return ChannelRestricted
	}
	self := move.ProfileID == move.Moderator.ProfileID
	if (self || move.ProfileID == s.Owner) && move.Destination == "" ||
		self && move.DeviceID != "" && move.DeviceID != move.Moderator.DeviceID {
		return HierarchyDenied
	}
	moderator, target := s.Members[move.Moderator.ProfileID], s.Members[move.ProfileID]
	grant := func(channel Channel) Decision {
		scope := s.scope(channel)
		if self {
			return s.CheckGrant(moderator, scope, "voice.connect", now)
		}
		if target.ID == s.Owner && target.Active && s.CheckGrant(moderator, Scope{}, Administrator, now) == Allowed {
			return s.CheckGrant(moderator, scope, "voice.move", now)
		}
		return s.CheckAction(moderator, target, scope, "voice.move", false, now)
	}
	if result := grant(from); result != Allowed {
		return result
	}
	if move.Destination == "" {
		return nil
	}
	to, exists := s.Channels[move.Destination]
	if !exists || to.Kind != "voice" || !s.CanDeliver(move.Moderator.ProfileID, move.Destination, 0) {
		return ChannelRestricted
	}
	if result := grant(to); result != Allowed {
		return result
	}
	return nil
}

func readLiveVoiceTargetSession(ctx context.Context, tx *sql.Tx, source, session string, now int64) (Principal, error) {
	var target Principal
	err := tx.QueryRowContext(ctx, `SELECT slot.profile_id,slot.device_id FROM protected_voice_slots slot
		WHERE slot.channel_id=? AND slot.session_id=? AND slot.active_until>? AND slot.grant_until>0 AND slot.disconnect_pending=0
		AND NOT EXISTS (SELECT 1 FROM protected_voice_moves move WHERE move.profile_id=slot.profile_id AND move.expires_at>?)`,
		source, session, now, now).Scan(&target.ProfileID, &target.DeviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, ErrVoiceSlotLost
	}
	return target, err
}

func VoiceMoveChoices(ctx context.Context, tx *sql.Tx, moderator Principal, source, session string, now int64) ([]string, error) {
	destinations := []string{}
	target, err := readLiveVoiceTargetSession(ctx, tx, source, session, now)
	if errors.Is(err, ErrVoiceSlotLost) {
		return destinations, nil
	}
	if err != nil {
		return nil, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return nil, err
	}
	move := VoiceMove{ProfileID: target.ProfileID, DeviceID: target.DeviceID, SessionID: session, Source: source, Moderator: moderator}
	if _, err := state.voiceAdmissionWithTimeout(ctx, tx, target, source, now); err != nil {
		var denied Decision
		if errors.As(err, &denied) {
			return destinations, nil
		}
		return nil, err
	}
	for _, destination := range orderedResources(state.ChannelOrder, state.Channels) {
		if destination == source || state.Channels[destination].Kind != "voice" {
			continue
		}
		move.Destination = destination
		if err := state.authorizeVoiceMove(ctx, tx, move, now); err != nil {
			var denied Decision
			if errors.As(err, &denied) || errors.Is(err, ErrVoiceFull) || errors.Is(err, ErrVoiceOccupied) {
				continue
			}
			return nil, err
		}
		destinations = append(destinations, destination)
	}
	return destinations, nil
}

func PlanVoiceMoveSession(ctx context.Context, tx *sql.Tx, moderator Principal, moderatorSession, session, source, destination string, now, expiry int64,
	observe func(session string) error) error {
	target, err := readLiveVoiceTargetSession(ctx, tx, source, session, now)
	if errors.Is(err, ErrVoiceSlotLost) {
		return ChannelRestricted
	}
	if err != nil {
		return err
	}
	if target.ProfileID == moderator.ProfileID && session != moderatorSession {
		return HierarchyDenied
	}
	return PlanVoiceMove(ctx, tx, moderator, target.ProfileID, source, destination, now, expiry, observe)
}

func PlanVoiceMove(ctx context.Context, tx *sql.Tx, moderator Principal, profile, source, destination string, now, expiry int64,
	observe func(session string) error) error {
	if source == destination || !isDigest(profile) {
		return InvalidAction
	}
	move := VoiceMove{ProfileID: profile, Source: source, Destination: destination, Moderator: moderator}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	if err := state.voiceMoveAuthority(move, now); err != nil {
		return err
	}
	err = tx.QueryRowContext(ctx, `SELECT session_id,device_id FROM protected_voice_slots
		WHERE channel_id=? AND profile_id=? AND active_until>?`, source, profile, now).Scan(&move.SessionID, &move.DeviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrVoiceSlotLost
	}
	if err != nil {
		return err
	}
	if err := state.authorizeVoiceMove(ctx, tx, move, now); err != nil {
		return err
	}
	if err := observe(move.SessionID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_voice_moves WHERE expires_at<=?", now); err != nil {
		return err
	}
	insert, err := tx.ExecContext(ctx, `INSERT INTO protected_voice_moves
		(profile_id,session_id,device_id,source,destination,moderator_profile,moderator_device,expires_at)
		VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO NOTHING`,
		profile, move.SessionID, move.DeviceID, source, destination, moderator.ProfileID, moderator.DeviceID, expiry)
	if err != nil {
		return err
	}
	count, err := insert.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrVoiceOccupied
	}
	return nil
}

func ApplyVoiceMove(ctx context.Context, tx *sql.Tx, profile string, now int64, remove func(VoiceMove) error) error {
	move := VoiceMove{ProfileID: profile}
	err := tx.QueryRowContext(ctx, `SELECT session_id,device_id,source,destination,moderator_profile,moderator_device
		FROM protected_voice_moves WHERE profile_id=? AND ready=0 AND expires_at>?`, profile, now).
		Scan(&move.SessionID, &move.DeviceID, &move.Source, &move.Destination, &move.Moderator.ProfileID, &move.Moderator.DeviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var stillReserved bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_voice_slots
		WHERE channel_id=? AND profile_id=? AND session_id=? AND device_id=? AND active_until>?)`,
		move.Source, profile, move.SessionID, move.DeviceID, now).Scan(&stillReserved); err != nil {
		return err
	}
	if !stillReserved {
		_, err := tx.ExecContext(ctx, "DELETE FROM protected_voice_moves WHERE profile_id=?", profile)
		return err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	if err := state.authorizeVoiceMove(ctx, tx, move, now); err != nil {
		var denied Decision
		if errors.As(err, &denied) || errors.Is(err, ErrVoiceFull) || errors.Is(err, ErrVoiceOccupied) {
			_, err = tx.ExecContext(ctx, "DELETE FROM protected_voice_moves WHERE profile_id=?", profile)
		}
		return err
	}
	if err := remove(move); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE protected_voice_slots SET active_until=0,grant_digest='',reconcile_pending=0
		WHERE channel_id=? AND profile_id=? AND session_id=?`, move.Source, profile, move.SessionID); err != nil {
		return err
	}
	if move.Destination == "" {
		_, err = tx.ExecContext(ctx, "DELETE FROM protected_voice_moves WHERE profile_id=?", profile)
	} else {
		_, err = tx.ExecContext(ctx, "UPDATE protected_voice_moves SET ready=1 WHERE profile_id=?", profile)
	}
	return err
}

func (s *Store) PendingVoiceMoveProfiles(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT profile_id FROM protected_voice_moves
		WHERE ready=0 AND expires_at>? ORDER BY expires_at,profile_id LIMIT 16`, s.now().UnixMilli())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pending []string
	for rows.Next() {
		var profile string
		if err := rows.Scan(&profile); err != nil {
			return nil, err
		}
		pending = append(pending, profile)
	}
	return pending, rows.Err()
}

func ReadyVoiceMove(ctx context.Context, tx *sql.Tx, actor Principal, session string, now int64) (string, error) {
	var destination string
	err := tx.QueryRowContext(ctx, `SELECT destination FROM protected_voice_moves
		WHERE profile_id=? AND session_id=? AND device_id=? AND ready=1 AND expires_at>?`,
		actor.ProfileID, session, actor.DeviceID, now).Scan(&destination)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if _, err := checkVoiceAdmission(ctx, tx, actor, destination, now); err != nil {
		return "", err
	}
	return destination, nil
}
