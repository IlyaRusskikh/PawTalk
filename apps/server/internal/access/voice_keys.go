package access

import (
	"context"
	"database/sql"
)

type VoiceKeyRecipient struct {
	SessionID string `json:"sessionId"`
	ProfileID string `json:"profileId"`
	DeviceID  string `json:"deviceId"`
	PublicKey string `json:"publicKey"`
}

// ReadVoiceKeyRoster uses current policy permissions and active, unexpired
// slots. A participant who can only listen still needs a package. A deafened
// participant may retain their voice slot without receiving the next secret.
func ReadVoiceKeyRoster(ctx context.Context, tx *sql.Tx, channel, binding string, now int64) ([]VoiceKeyRecipient, error) {
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT slot.session_id,slot.profile_id,slot.device_id
		FROM protected_voice_slots slot JOIN protected_runtime_sessions session
		ON session.session_id=slot.session_id AND session.device_id=slot.device_id
		LEFT JOIN protected_timeouts timeout ON timeout.profile_id=slot.profile_id
		WHERE slot.channel_id=? AND slot.active_until>? AND slot.disconnect_pending=0
		AND session.binding=? AND session.expires_at>? AND COALESCE(timeout.deadline,0)<=?
		ORDER BY slot.session_id`, channel, now, binding, now, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var roster []VoiceKeyRecipient
	for rows.Next() {
		var recipient VoiceKeyRecipient
		if err := rows.Scan(&recipient.SessionID, &recipient.ProfileID, &recipient.DeviceID); err != nil {
			return nil, err
		}
		actor := Principal{ProfileID: recipient.ProfileID, DeviceID: recipient.DeviceID}
		admission, err := state.voiceAdmission(actor, channel, now)
		key := state.KeyRecipients[actor.DeviceID]
		if err != nil || !admission.CanReceiveKey || key.Kind != "device" || key.ProfileID != actor.ProfileID {
			continue
		}
		recipient.PublicKey = key.PublicKey
		roster = append(roster, recipient)
		if len(roster) > 8192 {
			return nil, ErrEpochRecipients
		}
	}
	return roster, rows.Err()
}
