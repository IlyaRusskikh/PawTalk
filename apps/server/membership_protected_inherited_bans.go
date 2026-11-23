package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode"

	"pawtalk/server/internal/access"
)

const activeInheritedBan = `a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?)`

const inheritedBanEffectiveProfile = `COALESCE(json_extract(p.snapshot,'$.ProfileBindings."' || s.profile_id || '"'),
	CASE WHEN COALESCE(json_extract(p.snapshot,'$.ImportedProfileBindings'),0)=0 THEN
		COALESCE(json_extract(p.snapshot,'$.ProfileBindings."' || b.target_profile_id || '"'),b.target_profile_id) END,
	s.profile_id)`

func inheritedBanForProfile(ctx context.Context, query access.SessionQuery, profile string, now int64) (access.MemberRemoval, error) {
	var ban access.MemberRemoval
	err := query.QueryRowContext(ctx, `SELECT a.reason,COALESCE(a.expires_at,0) FROM ban_subjects s JOIN ban_actions a USING(ban_id)
		LEFT JOIN profile_bindings b ON b.source_profile_id=s.profile_id LEFT JOIN protected_policy p ON p.id=1
		WHERE `+activeInheritedBan+` AND `+inheritedBanEffectiveProfile+`=?
		ORDER BY a.expires_at IS NULL DESC,a.expires_at DESC,a.created_at DESC,a.ban_id LIMIT 1`,
		now, profile).Scan(&ban.Reason, &ban.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return access.MemberRemoval{}, nil
	}
	if err != nil {
		return access.MemberRemoval{}, err
	}
	ban.Action = access.BanPolicyMember
	ban.Reason = inheritedBanReason(ban.Reason)
	return ban, nil
}

func hasInheritedBan(ctx context.Context, query access.SessionQuery, profile string, now int64) (bool, error) {
	ban, err := inheritedBanForProfile(ctx, query, profile, now)
	return ban.BannedAt(now), err
}

func listInheritedBans(ctx context.Context, conn *sql.Conn, after string, now int64, limit int) ([]access.MemberBanInfo, error) {
	rows, err := conn.QueryContext(ctx, `WITH active AS (
		SELECT `+inheritedBanEffectiveProfile+` AS profile_id,a.reason,COALESCE(a.expires_at,0) AS expires_at,a.created_at,a.ban_id
		FROM ban_subjects s JOIN ban_actions a USING(ban_id)
		LEFT JOIN profile_bindings b ON b.source_profile_id=s.profile_id LEFT JOIN protected_policy p ON p.id=1
		WHERE `+activeInheritedBan+`
	), ranked AS (
		SELECT active.*,ROW_NUMBER() OVER (PARTITION BY profile_id
			ORDER BY expires_at=0 DESC,expires_at DESC,created_at DESC,ban_id) AS choice
		FROM active WHERE profile_id>?
		AND NOT EXISTS(SELECT 1 FROM protected_policy p,
			json_each(CAST(p.snapshot AS TEXT),'$.InheritedBanLifts') l
			WHERE p.id=1 AND l.key=active.profile_id AND l.value=1)
	) SELECT profile_id,reason,expires_at FROM ranked WHERE choice=1 ORDER BY profile_id LIMIT ?`, now, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var bans []access.MemberBanInfo
	for rows.Next() {
		ban := access.MemberBanInfo{Inherited: true}
		if err := rows.Scan(&ban.ProfileID, &ban.Reason, &ban.ExpiresAt); err != nil {
			return nil, err
		}
		ban.Reason = inheritedBanReason(ban.Reason)
		bans = append(bans, ban)
	}
	return bans, rows.Err()
}

func inheritedBanReason(reason string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, reason))
}
