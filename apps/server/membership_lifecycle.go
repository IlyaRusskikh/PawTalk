package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"strings"
)

func validHexID(value string, size int) bool {
	return len(value) == size && strings.Trim(value, "0123456789abcdef") == ""
}

func (s *membershipStore) mutate(ctx context.Context, token, requestID, action, permission string, payload []byte, operation func(*sql.Tx, memberAccess) error) error {
	if !validHexID(requestID, 32) {
		return memberError(400, "INVALID_REQUEST_ID")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	defer s.dropDeliveries(tx)
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(payload)
	var previousAction string
	var previousHash []byte
	err = tx.QueryRowContext(ctx, "SELECT action,payload_hash FROM mutation_receipts WHERE device_id=? AND request_id=?", access.DeviceID, requestID).Scan(&previousAction, &previousHash)
	if err == nil {
		if previousAction != action || !bytes.Equal(previousHash, digest[:]) {
			return memberError(409, "REQUEST_CONFLICT")
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if permission != "" && !access.allows(permission) {
		return memberError(403, "FORBIDDEN")
	}
	if err = operation(tx, access); err != nil {
		return err
	}
	now := s.now().UnixMilli()
	if _, err = tx.ExecContext(ctx, "INSERT INTO mutation_receipts(device_id,request_id,action,payload_hash,created_at) VALUES(?,?,?,?,?)", access.DeviceID, requestID, action, digest[:], now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE server_state SET revision=revision+1 WHERE id=1"); err != nil {
		return err
	}
	return s.commitDelivery(ctx, tx)
}

func (s *membershipStore) protectLastAdminTx(ctx context.Context, tx *sql.Tx, profileID string) error {
	var isActiveAdmin, count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM memberships m JOIN effective_profile_roles pr ON pr.profile_id=m.profile_id JOIN roles r ON r.role_id=pr.role_id
        WHERE m.profile_id=? AND m.state='active' AND r.system_kind='admin' AND NOT EXISTS(SELECT 1 FROM profile_bindings WHERE source_profile_id=m.profile_id)`, profileID).Scan(&isActiveAdmin); err != nil {
		return err
	}
	if isActiveAdmin == 0 {
		return nil
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(DISTINCT m.profile_id) FROM memberships m JOIN effective_profile_roles pr ON pr.profile_id=m.profile_id JOIN roles r ON r.role_id=pr.role_id
        WHERE m.state='active' AND r.system_kind='admin' AND NOT EXISTS(SELECT 1 FROM profile_bindings WHERE source_profile_id=m.profile_id)`).Scan(&count); err != nil {
		return err
	}
	if count <= 1 {
		return memberError(409, "LAST_ADMIN")
	}
	return nil
}

func (s *membershipStore) changeRole(ctx context.Context, token, target, role, requestID string) error {
	if !validHexID(target, 64) || (role != "member" && role != "moderator" && role != "admin") {
		return memberError(400, "INVALID_ROLE")
	}
	payload, _ := signatureFrame(target, role)
	return s.mutate(ctx, token, requestID, "role.set", "role.manage", payload, func(tx *sql.Tx, access memberAccess) error {
		var exists int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM memberships WHERE profile_id=?", target).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return memberError(404, "MEMBER_NOT_FOUND")
		}
		if role != "admin" {
			if err := s.protectLastAdminTx(ctx, tx, target); err != nil {
				return err
			}
		}
		table := "profile_roles"
		var override int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM group_roles g WHERE g.profile_id=? AND NOT EXISTS(SELECT 1 FROM profile_bindings b WHERE b.source_profile_id=g.profile_id)", target).Scan(&override); err != nil {
			return err
		}
		if override > 0 {
			table = "group_roles"
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE profile_id=? AND role_id IN(SELECT role_id FROM roles WHERE system_kind IS NOT NULL)", target); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO "+table+"(profile_id,role_id) VALUES(?,?)", target, role); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE profile_controls SET revision=revision+1 WHERE profile_id=?", target); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO audit_events(actor_profile_id,action,subject_id,created_at) VALUES(?,'role.set',?,?)", access.ProfileID, target, s.now().UnixMilli())
		return err
	})
}

func (s *membershipStore) endGroupTx(ctx context.Context, tx *sql.Tx, root, state string) error {
	now := s.now().UnixMilli()
	if _, err := tx.ExecContext(ctx, "UPDATE profile_controls SET revision=revision+1 WHERE profile_id=?", root); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE memberships SET state=?,ended_at=?,revision=revision+1 WHERE profile_id=? OR profile_id IN(SELECT source_profile_id FROM profile_bindings WHERE target_profile_id=?)`, state, now, root, root); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=? WHERE revoked_at IS NULL AND device_id IN(SELECT device_id FROM devices WHERE original_profile_id=? OR original_profile_id IN(SELECT source_profile_id FROM profile_bindings WHERE target_profile_id=?))`, now, root, root); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM voice_slots WHERE profile_id=?", root)
	return err
}

func (s *membershipStore) leave(ctx context.Context, token, requestID string) error {
	return s.mutate(ctx, token, requestID, "member.leave", "", nil, func(tx *sql.Tx, access memberAccess) error {
		if err := s.protectLastAdminTx(ctx, tx, access.EffectiveProfileID); err != nil {
			return err
		}
		if err := s.endGroupTx(ctx, tx, access.EffectiveProfileID, "left"); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO audit_events(actor_profile_id,action,subject_id,created_at) VALUES(?,'member.leave',?,?)", access.ProfileID, access.EffectiveProfileID, s.now().UnixMilli())
		return err
	})
}
