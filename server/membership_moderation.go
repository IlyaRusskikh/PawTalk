package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

func resolvedProfileTx(ctx context.Context, tx *sql.Tx, profile string) (string, error) {
	var root string
	err := tx.QueryRowContext(ctx, "SELECT COALESCE(b.target_profile_id,p.profile_id) FROM profiles p LEFT JOIN profile_bindings b ON b.source_profile_id=p.profile_id WHERE p.profile_id=?", profile).Scan(&root)
	if errors.Is(err, sql.ErrNoRows) {
		return "", memberError(404, "MEMBER_NOT_FOUND")
	}
	return root, err
}

func protectedAdminTx(ctx context.Context, tx *sql.Tx, root string) error {
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM effective_profile_roles p JOIN roles r ON r.role_id=p.role_id WHERE p.profile_id=? AND r.system_kind='admin'", root).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return memberError(403, "ADMIN_ROLE_MUST_BE_REMOVED")
	}
	return nil
}

type memberBanInfo struct {
	ID        string   `json:"id"`
	CreatedAt int64    `json:"createdAt"`
	ExpiresAt *int64   `json:"expiresAt"`
	Reason    string   `json:"reason"`
	Subjects  []string `json:"subjects"`
}

func (s *membershipStore) listBans(ctx context.Context, token string) ([]memberBanInfo, error) {
	result := []memberBanInfo{}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return nil, err
	}
	if !access.allows("member.ban") {
		return nil, memberError(403, "FORBIDDEN")
	}
	rows, err := tx.QueryContext(ctx, "SELECT ban_id,created_at,expires_at,reason FROM ban_actions WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 500", s.now().UnixMilli())
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var value memberBanInfo
		value.Subjects = []string{}
		if err = rows.Scan(&value.ID, &value.CreatedAt, &value.ExpiresAt, &value.Reason); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, value)
	}
	if err = closeMemberRows(rows); err != nil {
		return nil, err
	}
	for index := range result {
		rows, err = tx.QueryContext(ctx, "SELECT profile_id FROM ban_subjects WHERE ban_id=? ORDER BY profile_id", result[index].ID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var subject string
			if err = rows.Scan(&subject); err != nil {
				rows.Close()
				return nil, err
			}
			result[index].Subjects = append(result[index].Subjects, subject)
		}
		if err = closeMemberRows(rows); err != nil {
			return nil, err
		}
	}
	return result, tx.Commit()
}

func (s *membershipStore) kick(ctx context.Context, token, target, requestID string) error {
	if !validHexID(target, 64) {
		return memberError(400, "INVALID_PROFILE")
	}
	return s.mutate(ctx, token, requestID, "member.kick", "member.kick", []byte(target), func(tx *sql.Tx, access memberAccess) error {
		root, err := resolvedProfileTx(ctx, tx, target)
		if err != nil {
			return err
		}
		if err = protectedAdminTx(ctx, tx, root); err != nil {
			return err
		}
		if err = s.endGroupTx(ctx, tx, root, "kicked"); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_profile_id,action,subject_id,created_at) VALUES(?,'member.kick',?,?)", access.ProfileID, root, s.now().UnixMilli())
		return err
	})
}

func (s *membershipStore) ban(ctx context.Context, token, target, requestID string, expires *int64, reason string) error {
	reason = strings.TrimSpace(reason)
	if !validHexID(target, 64) || !utf8.ValidString(reason) || utf8.RuneCountInString(reason) > 512 || (expires != nil && *expires <= s.now().UnixMilli()) {
		return memberError(400, "INVALID_BAN")
	}
	payload, _ := json.Marshal(struct {
		Target  string
		Expires *int64
		Reason  string
	}{target, expires, reason})
	return s.mutate(ctx, token, requestID, "member.ban", "member.ban", payload, func(tx *sql.Tx, access memberAccess) error {
		root, err := resolvedProfileTx(ctx, tx, target)
		if err != nil {
			return err
		}
		if err = protectedAdminTx(ctx, tx, root); err != nil {
			return err
		}
		banID, err := randomHex(16)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO ban_actions(ban_id,issued_by_profile_id,created_at,expires_at,reason) VALUES(?,?,?,?,?)", banID, access.ProfileID, s.now().UnixMilli(), expires, reason); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO ban_subjects(ban_id,profile_id) SELECT ?,? UNION ALL SELECT ?,source_profile_id FROM profile_bindings WHERE target_profile_id=?`, banID, root, banID, root); err != nil {
			return err
		}
		if err = s.endGroupTx(ctx, tx, root, "kicked"); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_profile_id,action,subject_id,created_at) VALUES(?,'member.ban',?,?)", access.ProfileID, banID, s.now().UnixMilli())
		return err
	})
}

func (s *membershipStore) revokeBan(ctx context.Context, token, banID, requestID string) error {
	if !validHexID(banID, 32) {
		return memberError(400, "INVALID_BAN")
	}
	return s.mutate(ctx, token, requestID, "ban.revoke", "member.ban", []byte(banID), func(tx *sql.Tx, access memberAccess) error {
		result, err := tx.ExecContext(ctx, "UPDATE ban_actions SET revoked_at=COALESCE(revoked_at,?) WHERE ban_id=?", s.now().UnixMilli(), banID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return memberError(404, "BAN_NOT_FOUND")
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(actor_profile_id,action,subject_id,created_at) VALUES(?,'ban.revoke',?,?)", access.ProfileID, banID, s.now().UnixMilli())
		return err
	})
}
