package main

import (
	"context"
	"database/sql"
)

type memberMediaTarget struct{ Room, Identity string }

func memberMediaTargetsTx(ctx context.Context, tx *sql.Tx, clause string, args ...any) ([]memberMediaTarget, error) {
	rows, err := tx.QueryContext(ctx, `SELECT 'pt-'||st.server_id||'-'||v.channel_id,v.session_id FROM voice_slots v JOIN sessions s ON s.session_id=v.session_id CROSS JOIN server_state st WHERE st.id=1 AND `+clause, args...)
	if err != nil {
		return nil, err
	}
	result := []memberMediaTarget{}
	for rows.Next() {
		var v memberMediaTarget
		if err = rows.Scan(&v.Room, &v.Identity); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, v)
	}
	return result, closeMemberRows(rows)
}
func (s *membershipStore) captureGroupMedia(ctx context.Context, profile string) []memberMediaTarget {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil
	}
	defer tx.Rollback()
	root, err := resolvedProfileTx(ctx, tx, profile)
	if err != nil {
		return nil
	}
	result, _ := memberMediaTargetsTx(ctx, tx, "v.profile_id=?", root)
	return result
}
func (s *membershipStore) captureDeviceMedia(ctx context.Context, device string) []memberMediaTarget {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil
	}
	defer tx.Rollback()
	result, _ := memberMediaTargetsTx(ctx, tx, "s.device_id=?", device)
	return result
}
func (s *membershipStore) captureOwnGroupMedia(ctx context.Context, token string) []memberMediaTarget {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return nil
	}
	result, _ := memberMediaTargetsTx(ctx, tx, "v.profile_id=?", access.EffectiveProfileID)
	return result
}
func (a *membershipAPI) removeTargets(ctx context.Context, targets []memberMediaTarget) {
	for _, target := range targets {
		a.removeMedia(ctx, target.Room, target.Identity)
	}
}

func (s *membershipStore) captureLinkMedia(ctx context.Context, id string) []memberMediaTarget {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil
	}
	defer tx.Rollback()
	result, _ := memberMediaTargetsTx(ctx, tx, "EXISTS(SELECT 1 FROM device_link_requests l WHERE l.request_id=? AND v.profile_id IN(l.source_profile_id,l.target_profile_id) AND v.profile_id<>l.chosen_profile_id)", id)
	return result
}
func (s *membershipStore) channelRoom(ctx context.Context, channel string) string {
	var room string
	s.db.QueryRowContext(ctx, "SELECT 'pt-'||s.server_id||'-'||c.channel_id FROM server_state s CROSS JOIN channels c WHERE s.id=1 AND c.channel_id=? AND c.kind='voice'", channel).Scan(&room)
	return room
}
