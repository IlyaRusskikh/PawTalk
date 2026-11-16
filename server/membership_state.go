package main

import (
	"context"
	"database/sql"
)

type memberChannel struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	Name            string `json:"name"`
	Position        int    `json:"position"`
	Protected       bool   `json:"protected"`
	Revision        int64  `json:"revision"`
	MessageRevision int64  `json:"messageRevision"`
	LastMessageID   int64  `json:"lastMessageId"`
}
type memberProfile struct {
	ID                     string `json:"id"`
	Nickname               string `json:"nickname"`
	Avatar                 []byte `json:"avatarEnvelope,omitempty"`
	Revision               int64  `json:"revision"`
	AvatarContextProfileID string `json:"avatarContextProfileId"`
}
type memberBinding struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	Revision int64  `json:"revision"`
}
type memberRosterEntry struct {
	ProfileID string `json:"profileId"`
	Away      bool   `json:"away"`
	Online    bool   `json:"online"`
	Role      string `json:"role"`
}
type memberDevice struct {
	ID                string `json:"id"`
	OriginalProfileID string `json:"originalProfileId"`
	Label             string `json:"label"`
	Primary           bool   `json:"primary"`
}
type membershipState struct {
	Capabilities    []string              `json:"capabilities"`
	ServerID        string                `json:"serverId"`
	Name            string                `json:"name"`
	KeyID           string                `json:"keyId"`
	Revision        int64                 `json:"revision"`
	Self            memberAccess          `json:"self"`
	Devices         []memberDevice        `json:"devices"`
	Channels        []memberChannel       `json:"channels"`
	Members         []memberRosterEntry   `json:"members"`
	Profiles        []memberProfile       `json:"profiles"`
	Bindings        []memberBinding       `json:"bindings"`
	ControlRevision int64                 `json:"controlRevision"`
	Voice           []memberVoicePresence `json:"voice"`
}

type memberVoicePresence struct {
	ProfileID string `json:"profileId"`
	DeviceID  string `json:"deviceId"`
	ChannelID string `json:"channelId"`
	Identity  string `json:"identity"`
}

func (s *membershipStore) state(ctx context.Context, token string) (membershipState, error) {
	result := membershipState{Channels: []memberChannel{}, Members: []memberRosterEntry{}, Profiles: []memberProfile{}, Bindings: []memberBinding{}, Devices: []memberDevice{}}
	result.Voice = []memberVoicePresence{}
	result.Capabilities = membershipCapabilities
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if result.Self, err = s.sessionAccessTx(ctx, tx, token); err != nil {
		return result, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT revision FROM profile_controls WHERE profile_id=?", result.Self.EffectiveProfileID).Scan(&result.ControlRevision); err != nil {
		return result, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT server_id,name,COALESCE(e2ee_key_id,''),revision FROM server_state WHERE id=1").Scan(&result.ServerID, &result.Name, &result.KeyID, &result.Revision); err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT channel_id,kind,name,position,protected_kind IS NOT NULL,revision,message_revision,COALESCE((SELECT MAX(message_id) FROM messages m WHERE m.channel_id=channels.channel_id),0) FROM channels ORDER BY position,channel_id")
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var v memberChannel
		if err = rows.Scan(&v.ID, &v.Kind, &v.Name, &v.Position, &v.Protected, &v.Revision, &v.MessageRevision, &v.LastMessageID); err != nil {
			rows.Close()
			return result, err
		}
		result.Channels = append(result.Channels, v)
	}
	if err = closeMemberRows(rows); err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT p.profile_id,p.nickname,p.avatar_envelope,p.revision,p.avatar_profile_id FROM effective_profiles p WHERE EXISTS(SELECT 1 FROM memberships m WHERE m.profile_id=p.profile_id) OR EXISTS(SELECT 1 FROM messages m WHERE m.author_profile_id=p.profile_id) ORDER BY p.created_at,p.profile_id`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var v memberProfile
		if err = rows.Scan(&v.ID, &v.Nickname, &v.Avatar, &v.Revision, &v.AvatarContextProfileID); err != nil {
			rows.Close()
			return result, err
		}
		result.Profiles = append(result.Profiles, v)
	}
	if err = closeMemberRows(rows); err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT source_profile_id,target_profile_id,revision FROM profile_bindings ORDER BY source_profile_id")
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var v memberBinding
		if err = rows.Scan(&v.Source, &v.Target, &v.Revision); err != nil {
			rows.Close()
			return result, err
		}
		result.Bindings = append(result.Bindings, v)
	}
	if err = closeMemberRows(rows); err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT d.device_id,d.original_profile_id,d.label,COALESCE(c.primary_device_id=d.device_id,0)
        FROM devices d LEFT JOIN profile_controls c ON c.profile_id=?
        WHERE d.original_profile_id=? OR d.original_profile_id IN(SELECT source_profile_id FROM profile_bindings WHERE target_profile_id=?) ORDER BY d.created_at,d.device_id`, result.Self.EffectiveProfileID, result.Self.EffectiveProfileID, result.Self.EffectiveProfileID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var v memberDevice
		if err = rows.Scan(&v.ID, &v.OriginalProfileID, &v.Label, &v.Primary); err != nil {
			rows.Close()
			return result, err
		}
		result.Devices = append(result.Devices, v)
	}
	if err = closeMemberRows(rows); err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT m.profile_id,
        EXISTS(SELECT 1 FROM sessions s JOIN devices d ON d.device_id=s.device_id WHERE s.revoked_at IS NULL AND s.expires_at>? AND s.last_seen_at>? AND
          (d.original_profile_id=m.profile_id OR d.original_profile_id IN(SELECT source_profile_id FROM profile_bindings WHERE target_profile_id=m.profile_id))),
        NOT EXISTS(SELECT 1 FROM sessions s JOIN devices d ON d.device_id=s.device_id LEFT JOIN session_activity a ON a.session_id=s.session_id WHERE s.revoked_at IS NULL AND s.expires_at>? AND s.last_seen_at>? AND COALESCE(a.away,0)=0 AND
 (d.original_profile_id=m.profile_id OR d.original_profile_id IN(SELECT source_profile_id FROM profile_bindings WHERE target_profile_id=m.profile_id))),
        COALESCE((SELECT MAX(CASE r.system_kind WHEN 'admin' THEN 3 WHEN 'moderator' THEN 2 ELSE 1 END) FROM effective_profile_roles pr JOIN roles r ON r.role_id=pr.role_id WHERE pr.profile_id=m.profile_id),1)
        FROM memberships m WHERE m.state='active' AND NOT EXISTS(SELECT 1 FROM profile_bindings b WHERE b.source_profile_id=m.profile_id)
        AND NOT EXISTS(SELECT 1 FROM ban_subjects bs JOIN ban_actions ba ON ba.ban_id=bs.ban_id WHERE bs.profile_id=m.profile_id AND ba.revoked_at IS NULL AND (ba.expires_at IS NULL OR ba.expires_at>?)) ORDER BY m.joined_at,m.profile_id`, s.now().UnixMilli(), s.now().UnixMilli()-45000, s.now().UnixMilli(), s.now().UnixMilli()-45000, s.now().UnixMilli())
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var v memberRosterEntry
		var role int
		if err = rows.Scan(&v.ProfileID, &v.Online, &v.Away, &role); err != nil {
			rows.Close()
			return result, err
		}
		v.Role = map[int]string{1: "member", 2: "moderator", 3: "admin"}[role]
		result.Members = append(result.Members, v)
	}
	if err = closeMemberRows(rows); err != nil {
		return result, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT v.profile_id,s.device_id,v.channel_id,v.session_id FROM voice_slots v JOIN sessions s ON s.session_id=v.session_id JOIN memberships m ON m.profile_id=v.profile_id WHERE v.expires_at>? AND s.revoked_at IS NULL AND s.expires_at>? AND m.state='active' ORDER BY v.channel_id,v.profile_id`, s.now().UnixMilli(), s.now().UnixMilli())
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var v memberVoicePresence
		if err = rows.Scan(&v.ProfileID, &v.DeviceID, &v.ChannelID, &v.Identity); err != nil {
			rows.Close()
			return result, err
		}
		result.Voice = append(result.Voice, v)
	}
	if err = closeMemberRows(rows); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func closeMemberRows(rows *sql.Rows) error {
	err := rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return err
	}
	return closeErr
}
