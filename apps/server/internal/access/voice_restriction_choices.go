package access

import (
	"context"
	"database/sql"
	"errors"
	"slices"
)

type VoiceRestrictionChoice struct {
	Action     string `json:"action"`
	Lift       bool   `json:"lift"`
	ServerWide bool   `json:"serverWide,omitempty"`
}

type VoiceRestrictionChoices struct {
	ProfileID     string                   `json:"profileId,omitempty"`
	Actions       []VoiceRestrictionChoice `json:"actions"`
	CanDisconnect bool                     `json:"canDisconnect,omitempty"`
}

func currentVoiceRestrictionChoices(ctx context.Context, tx *sql.Tx, state State, moderator Principal, source, session string,
	now int64) (VoiceRestrictionChoices, error) {
	result := VoiceRestrictionChoices{Actions: []VoiceRestrictionChoice{}}
	if !state.CanDeliver(moderator.ProfileID, source, 0) {
		return result, nil
	}
	target, err := readLiveVoiceTargetSession(ctx, tx, source, session, now)
	if errors.Is(err, ErrVoiceSlotLost) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	self := target.ProfileID == moderator.ProfileID
	if self && state.CheckGrant(state.Members[moderator.ProfileID], Scope{}, Administrator, now) != Allowed {
		return result, nil
	}
	if _, err := state.voiceAdmissionWithTimeout(ctx, tx, target, source, now); err != nil {
		var denied Decision
		if errors.As(err, &denied) {
			return result, nil
		}
		return result, err
	}
	move := VoiceMove{ProfileID: target.ProfileID, DeviceID: target.DeviceID, Source: source, SessionID: session, Moderator: moderator}
	result.CanDisconnect = !self && state.voiceMoveAuthority(move, now) == nil
	if !state.canInspectFullPolicy(moderator) {
		return result, nil
	}
	allowed := func(option VoiceRestrictionChoice) bool {
		return (!self || option.Lift && (option.ServerWide || moderator.ProfileID == state.Owner)) &&
			state.voiceRestrictionAuthority(moderator.ProfileID, target.ProfileID, source, option.Action, option.Lift, true, now) == Allowed
	}
	restriction := state.VoiceRestrictions[source][target.ProfileID]
	for _, option := range []VoiceRestrictionChoice{{Action: ChangeVoiceMute, Lift: restriction.Muted}, {Action: ChangeVoiceDeafen, Lift: restriction.Deafened}} {
		if allowed(option) {
			result.Actions = append(result.Actions, option)
		}
	}
	global := state.VoiceRestrictions[serverVoiceRestriction][target.ProfileID]
	for _, option := range []VoiceRestrictionChoice{{Action: ChangeVoiceMute, Lift: global.Muted, ServerWide: true}, {Action: ChangeVoiceDeafen, Lift: global.Deafened || global.MediaDeafened, ServerWide: true}} {
		if state.canChangeServerVoiceRestriction(moderator.ProfileID, target.ProfileID, option.Lift) && allowed(option) {
			result.Actions = append(result.Actions, option)
		}
	}
	if len(result.Actions) != 0 {
		result.ProfileID = target.ProfileID
	}
	return result, nil
}

func DisconnectVoiceSession(ctx context.Context, tx *sql.Tx, moderator Principal, source, session string, now int64) (string, error) {
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return "", err
	}
	target, err := readLiveVoiceTargetSession(ctx, tx, source, session, now)
	if err != nil {
		return "", err
	}
	move := VoiceMove{ProfileID: target.ProfileID, DeviceID: target.DeviceID, Source: source, SessionID: session, Moderator: moderator}
	if err := state.voiceMoveAuthority(move, now); err != nil {
		return "", err
	}
	if _, err := state.voiceAdmissionWithTimeout(ctx, tx, target, source, now); err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `UPDATE protected_voice_slots SET active_until=0, disconnect_pending=1
		WHERE profile_id=? AND channel_id=? AND session_id=?`, target.ProfileID, source, session)
	return target.ProfileID, err
}

func ReadVoiceRestrictionChoices(ctx context.Context, tx *sql.Tx, moderator Principal, source, session string, now int64) (VoiceRestrictionChoices, error) {
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return VoiceRestrictionChoices{}, err
	}
	return currentVoiceRestrictionChoices(ctx, tx, state, moderator, source, session, now)
}

func validateVoiceRestrictionTargetSession(ctx context.Context, tx *sql.Tx, state State, moderator Principal, draft PolicyDraft, now int64) error {
	change := draft.ResourceChange
	if change == nil || change.VoiceTargetSessionID == "" {
		return nil
	}
	if (draft.Action != ChangeVoiceMute && draft.Action != ChangeVoiceDeafen) || !validRotationID(change.VoiceTargetSessionID) {
		return InvalidAction
	}
	choices, err := currentVoiceRestrictionChoices(ctx, tx, state, moderator, change.ID, change.VoiceTargetSessionID, now)
	if err != nil {
		return err
	}
	serverWide := change.Mode == "server" || change.Mode == "server-media"
	if choices.ProfileID != change.TargetProfileID || !slices.Contains(choices.Actions, VoiceRestrictionChoice{Action: draft.Action, Lift: change.Lift, ServerWide: serverWide}) {
		return ChannelRestricted
	}
	return nil
}
