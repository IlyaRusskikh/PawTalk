package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
)

type memberInvitePackage struct {
	Version    int    `json:"version"`
	KeyID      string `json:"keyId"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}
type memberInviteCreate struct {
	InviteID      string          `json:"inviteId"`
	TokenHash     string          `json:"tokenHash"`
	Kind          string          `json:"kind"`
	KeyPackage    json.RawMessage `json:"keyPackage"`
	PackageDigest string          `json:"packageDigest"`
	RequestID     string          `json:"requestId"`
}
type memberPrepare struct {
	InviteID    string `json:"inviteId"`
	Token       string `json:"token"`
	RequestID   string `json:"requestId"`
	Nickname    string `json:"nickname"`
	DeviceLabel string `json:"deviceLabel"`
}
type memberPrepared struct {
	AttemptID     string          `json:"attemptId"`
	Deadline      int64           `json:"deadline"`
	Kind          string          `json:"kind"`
	State         string          `json:"state"`
	KeyPackage    json.RawMessage `json:"keyPackage"`
	PackageDigest string          `json:"packageDigest"`
}
type memberConfirm struct {
	AttemptID     string `json:"attemptId"`
	RequestID     string `json:"requestId"`
	PackageDigest string `json:"packageDigest"`
	KeyID         string `json:"keyId"`
}
type memberBootstrap struct {
	InviteID  string `json:"inviteId"`
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expiresAt"`
	ServerID  string `json:"serverId"`
}

type memberInviteInfo struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Creator   string `json:"creatorProfileId"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	RevokedAt *int64 `json:"revokedAt"`
	UsedCount int    `json:"usedCount"`
}

func (s *membershipStore) listInvites(ctx context.Context, token string) ([]memberInviteInfo, error) {
	result := []memberInviteInfo{}
	if err := s.expireInvitations(ctx); err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return result, err
	}
	if !access.allows("invite.create") {
		return result, memberError(403, "FORBIDDEN")
	}
	rows, err := tx.QueryContext(ctx, `SELECT i.invite_id,i.kind,i.created_by_profile_id,i.created_at,i.expires_at,i.revoked_at,i.used_count FROM invites i LEFT JOIN profile_bindings b ON b.source_profile_id=i.created_by_profile_id WHERE i.kind<>'bootstrap' AND (? OR COALESCE(b.target_profile_id,i.created_by_profile_id)=?) AND i.revoked_at IS NULL AND i.expires_at>? AND (i.max_uses IS NULL OR i.used_count<i.max_uses) ORDER BY i.created_at DESC LIMIT 200`, access.allows("invite.revoke.any"), access.EffectiveProfileID, s.now().UnixMilli())
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var v memberInviteInfo
		if err = rows.Scan(&v.ID, &v.Kind, &v.Creator, &v.CreatedAt, &v.ExpiresAt, &v.RevokedAt, &v.UsedCount); err != nil {
			rows.Close()
			return result, err
		}
		result = append(result, v)
	}
	if err = closeMemberRows(rows); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (s *membershipStore) revokeInvite(ctx context.Context, token, id, requestID string) error {
	if !validHexID(id, 32) {
		return memberError(400, "INVALID_INVITE")
	}
	return s.mutate(ctx, token, requestID, "invite.revoke", "invite.revoke.own", []byte(id), func(tx *sql.Tx, access memberAccess) error {
		var creator string
		err := tx.QueryRowContext(ctx, "SELECT COALESCE(b.target_profile_id,i.created_by_profile_id) FROM invites i LEFT JOIN profile_bindings b ON b.source_profile_id=i.created_by_profile_id WHERE i.invite_id=? AND i.kind<>'bootstrap'", id).Scan(&creator)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(404, "INVITE_NOT_FOUND")
		}
		if err != nil {
			return err
		}
		if creator != access.EffectiveProfileID && !access.allows("invite.revoke.any") {
			return memberError(403, "FORBIDDEN")
		}
		if _, err = tx.ExecContext(ctx, "UPDATE invites SET revoked_at=COALESCE(revoked_at,?),encrypted_key_package=NULL WHERE invite_id=?", s.now().UnixMilli(), id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE invite_attempts SET state='cancelled' WHERE invite_id=? AND state='reserved'", id)
		return err
	})
}

func (s *membershipStore) createBootstrap(ctx context.Context) (memberBootstrap, error) {
	var result memberBootstrap
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var initialized int
	if err = tx.QueryRowContext(ctx, "SELECT server_id,e2ee_key_id IS NOT NULL FROM server_state WHERE id=1").Scan(&result.ServerID, &initialized); err != nil {
		return result, err
	}
	if initialized != 0 {
		return result, memberError(409, "ALREADY_INITIALIZED")
	}
	result.InviteID, err = randomHex(16)
	if err != nil {
		return result, err
	}
	var raw []byte
	result.Token, raw, err = randomToken()
	if err != nil {
		return result, err
	}
	hash := sha256.Sum256(raw)
	now := s.now().UnixMilli()
	result.ExpiresAt = now + 86400000
	if _, err = tx.ExecContext(ctx, "UPDATE invites SET revoked_at=?,encrypted_key_package=NULL WHERE kind='bootstrap' AND revoked_at IS NULL", now); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE invite_attempts SET state='cancelled' WHERE invite_kind='bootstrap' AND state='reserved'"); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO invites(invite_id,token_hash,kind,created_at,expires_at,max_uses) VALUES(?,?,'bootstrap',?,?,1)", result.InviteID, hash[:], now, result.ExpiresAt); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (s *membershipStore) expireInvitations(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := s.now().UnixMilli()
	if _, err = tx.ExecContext(ctx, "UPDATE invite_attempts SET state='expired' WHERE state='reserved' AND deadline<=?", now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE invites SET revoked_at=COALESCE(revoked_at,?) WHERE kind IN ('single','bootstrap') AND EXISTS(SELECT 1 FROM invite_attempts a WHERE a.invite_id=invites.invite_id AND a.state='expired')`, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE invites SET encrypted_key_package=NULL WHERE revoked_at IS NOT NULL OR expires_at<=? OR (max_uses IS NOT NULL AND used_count>=max_uses)", now); err != nil {
		return err
	}
	return tx.Commit()
}

func validateMemberPackage(raw json.RawMessage, digest string) (memberInvitePackage, error) {
	var packet memberInvitePackage
	if len(raw) < 64 || len(raw) > 4096 || !validHexID(digest, 64) {
		return packet, memberError(400, "INVALID_KEY_PACKAGE")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&packet) != nil || packet.Version != 2 || !validHexID(packet.KeyID, 64) {
		return packet, memberError(400, "INVALID_KEY_PACKAGE")
	}
	if _, err := decodeFixed(packet.Nonce, 12); err != nil {
		return packet, memberError(400, "INVALID_KEY_PACKAGE")
	}
	cipher, err := b64.Strict().DecodeString(packet.Ciphertext)
	if err != nil || len(cipher) < 17 || len(cipher) > 2048 || b64.EncodeToString(cipher) != packet.Ciphertext {
		return packet, memberError(400, "INVALID_KEY_PACKAGE")
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != digest {
		return packet, memberError(400, "PACKAGE_DIGEST_MISMATCH")
	}
	return packet, nil
}

func (s *membershipStore) createInvite(ctx context.Context, token string, input memberInviteCreate) error {
	if !validHexID(input.InviteID, 32) || !validHexID(input.TokenHash, 64) || (input.Kind != "single" && input.Kind != "reusable") {
		return memberError(400, "INVALID_INVITE")
	}
	packet, err := validateMemberPackage(input.KeyPackage, input.PackageDigest)
	if err != nil {
		return err
	}
	if err = s.expireInvitations(ctx); err != nil {
		return err
	}
	payload, _ := json.Marshal(input)
	return s.mutate(ctx, token, input.RequestID, "invite.create", "invite.create", payload, func(tx *sql.Tx, access memberAccess) error {
		var configured string
		if err := tx.QueryRowContext(ctx, "SELECT COALESCE(e2ee_key_id,'') FROM server_state WHERE id=1").Scan(&configured); err != nil {
			return err
		}
		if configured != packet.KeyID {
			return memberError(409, "KEY_ID_MISMATCH")
		}
		var count int
		now := s.now().UnixMilli()
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM invites WHERE kind=? AND revoked_at IS NULL AND expires_at>? AND (max_uses IS NULL OR used_count<max_uses)", input.Kind, now).Scan(&count); err != nil {
			return err
		}
		if count >= 100 {
			return memberError(409, "INVITE_LIMIT")
		}
		ttl := int64(86400000)
		var max any = 1
		if input.Kind == "reusable" {
			ttl = 3600000
			max = nil
		}
		hash, _ := hex.DecodeString(input.TokenHash)
		digest, _ := hex.DecodeString(input.PackageDigest)
		_, err := tx.ExecContext(ctx, "INSERT INTO invites(invite_id,token_hash,kind,created_by_profile_id,created_at,expires_at,max_uses,encrypted_key_package,package_digest) VALUES(?,?,?,?,?,?,?,?,?)", input.InviteID, hash, input.Kind, access.ProfileID, now, now+ttl, max, []byte(input.KeyPackage), digest)
		if err != nil {
			return memberError(409, "INVITE_CONFLICT")
		}
		return nil
	})
}

func (s *membershipStore) memberBannedTx(ctx context.Context, tx *sql.Tx, profile string) error {
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM ban_subjects s JOIN ban_actions a ON a.ban_id=s.ban_id WHERE s.profile_id=? AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?)`, profile, s.now().UnixMilli()).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return memberError(403, "BANNED")
	}
	return nil
}

func (s *membershipStore) joiningRootTx(ctx context.Context, tx *sql.Tx, id memberIdentity) (string, error) {
	root := id.ProfileID
	var target string
	err := tx.QueryRowContext(ctx, "SELECT target_profile_id FROM profile_bindings WHERE source_profile_id=?", root).Scan(&target)
	if err == nil {
		root = target
	} else if !errors.Is(err, sql.ErrNoRows) {
		return root, err
	}
	var boundCount int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM profile_bindings WHERE target_profile_id=?", root).Scan(&boundCount); err != nil {
		return root, err
	}
	if boundCount > 0 {
		var main string
		if err = tx.QueryRowContext(ctx, "SELECT primary_device_id FROM profile_controls WHERE profile_id=?", root).Scan(&main); err != nil {
			return root, err
		}
		if main != id.DeviceID {
			return root, memberError(409, "LINKED_PROFILE_USE_MAIN")
		}
	}
	return root, nil
}

func (s *membershipStore) prepareInvite(ctx context.Context, proof membershipProof, method, uri string, raw []byte, input memberPrepare) (memberPrepared, error) {
	var result memberPrepared
	if !validHexID(input.InviteID, 32) || !validHexID(input.RequestID, 32) {
		return result, memberError(400, "INVALID_INVITE")
	}
	admission, err := decodeFixed(input.Token, 32)
	if err != nil {
		return result, memberError(403, "INVALID_INVITE")
	}
	hash := sha256.Sum256(admission)
	if err = s.expireInvitations(ctx); err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var kind string
	var expires int64
	var revoked sql.NullInt64
	var used int
	var keyPackage, digest []byte
	err = tx.QueryRowContext(ctx, "SELECT kind,expires_at,revoked_at,used_count,encrypted_key_package,package_digest FROM invites WHERE invite_id=? AND token_hash=?", input.InviteID, hash[:]).Scan(&kind, &expires, &revoked, &used, &keyPackage, &digest)
	if errors.Is(err, sql.ErrNoRows) {
		return result, memberError(403, "INVALID_INVITE")
	}
	if err != nil {
		return result, err
	}
	// Verify existing attempts before expiry/used checks: a lost successful reply
	// must not be mistaken for an unconsumed invitation on the next request.
	id, err := s.proveDeviceTx(ctx, tx, proof, method, uri, raw, input.Nickname, input.DeviceLabel, true)
	if err != nil {
		return result, err
	}
	if err = s.memberBannedTx(ctx, tx, id.ProfileID); err != nil {
		return result, err
	}
	root, err := s.joiningRootTx(ctx, tx, id)
	if err != nil {
		return result, err
	}
	if err = s.memberBannedTx(ctx, tx, root); err != nil {
		return result, err
	}
	var existingRequest string
	err = tx.QueryRowContext(ctx, "SELECT attempt_id,deadline,state,request_id FROM invite_attempts WHERE invite_id=? AND device_id=?", input.InviteID, id.DeviceID).Scan(&result.AttemptID, &result.Deadline, &result.State, &existingRequest)
	if err == nil {
		if result.State == "expired" || result.State == "cancelled" {
			return result, memberError(410, "NEW_INVITE_REQUIRED")
		}
		if existingRequest != input.RequestID {
			return result, memberError(409, "REQUEST_CONFLICT")
		}
		result.Kind = kind
		result.KeyPackage = keyPackage
		result.PackageDigest = hex.EncodeToString(digest)
		if result.State != "confirmed" && (revoked.Valid || expires <= s.now().UnixMilli()) {
			return result, memberError(410, "INVITE_EXPIRED")
		}
		return result, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if revoked.Valid || expires <= s.now().UnixMilli() || (kind != "reusable" && used >= 1) {
		return result, memberError(410, "INVITE_EXPIRED")
	}
	var active int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM memberships WHERE profile_id=? AND state='active'", root).Scan(&active); err != nil {
		return result, err
	}
	if active > 0 {
		return result, memberError(409, "ALREADY_A_MEMBER")
	}
	var initialized int
	if err = tx.QueryRowContext(ctx, "SELECT e2ee_key_id IS NOT NULL FROM server_state WHERE id=1").Scan(&initialized); err != nil {
		return result, err
	}
	if (kind == "bootstrap" && initialized != 0) || (kind != "bootstrap" && initialized == 0) {
		return result, memberError(409, "SETUP_STATE_CHANGED")
	}
	result.AttemptID, err = randomHex(16)
	if err != nil {
		return result, err
	}
	result.Deadline = s.now().UnixMilli() + membershipReservationSeconds*1000
	if expires < result.Deadline {
		result.Deadline = expires
	}
	result.State = "reserved"
	result.Kind = kind
	result.KeyPackage = keyPackage
	result.PackageDigest = hex.EncodeToString(digest)
	_, err = tx.ExecContext(ctx, "INSERT INTO invite_attempts(attempt_id,invite_id,invite_kind,profile_id,device_id,request_id,state,reserved_at,deadline,package_digest) VALUES(?,?,?,?,?,?,'reserved',?,?,?)", result.AttemptID, input.InviteID, kind, id.ProfileID, id.DeviceID, input.RequestID, s.now().UnixMilli(), result.Deadline, digest)
	if err != nil {
		return result, memberError(409, "INVITE_RESERVED")
	}
	return result, tx.Commit()
}

func (s *membershipStore) confirmInvite(ctx context.Context, proof membershipProof, method, uri string, raw []byte, input memberConfirm) (memberSession, error) {
	var result memberSession
	if !validHexID(input.AttemptID, 32) || !validHexID(input.RequestID, 32) || !validHexID(input.KeyID, 64) {
		return result, memberError(400, "INVALID_CONFIRMATION")
	}
	if err := s.expireInvitations(ctx); err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	id, err := s.proveDeviceTx(ctx, tx, proof, method, uri, raw, "", "", false)
	if err != nil {
		return result, err
	}
	var inviteID, kind, state, requestID, device string
	var deadline int64
	var digest []byte
	err = tx.QueryRowContext(ctx, "SELECT invite_id,invite_kind,state,request_id,device_id,deadline,package_digest FROM invite_attempts WHERE attempt_id=?", input.AttemptID).Scan(&inviteID, &kind, &state, &requestID, &device, &deadline, &digest)
	if errors.Is(err, sql.ErrNoRows) {
		return result, memberError(404, "ATTEMPT_NOT_FOUND")
	}
	if err != nil {
		return result, err
	}
	if device != id.DeviceID || requestID != input.RequestID {
		return result, memberError(403, "FORBIDDEN")
	}
	if hex.EncodeToString(digest) != input.PackageDigest {
		return result, memberError(400, "PACKAGE_DIGEST_MISMATCH")
	}
	if state == "confirmed" {
		var current string
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(e2ee_key_id,'') FROM server_state WHERE id=1").Scan(&current); err != nil {
			return result, err
		}
		if current != input.KeyID {
			return result, memberError(409, "KEY_ID_MISMATCH")
		}
		result, err = s.newSessionTx(ctx, tx, id)
		if err != nil {
			return result, err
		}
		return result, tx.Commit()
	}
	if state != "reserved" || deadline <= s.now().UnixMilli() {
		return result, memberError(410, "NEW_INVITE_REQUIRED")
	}
	if hex.EncodeToString(digest) != input.PackageDigest {
		return result, memberError(400, "PACKAGE_DIGEST_MISMATCH")
	}
	var revoked sql.NullInt64
	var expiry int64
	var configured sql.NullString
	if err = tx.QueryRowContext(ctx, "SELECT revoked_at,expires_at FROM invites WHERE invite_id=?", inviteID).Scan(&revoked, &expiry); err != nil {
		return result, err
	}
	if revoked.Valid || expiry <= s.now().UnixMilli() {
		return result, memberError(410, "INVITE_EXPIRED")
	}
	if err = tx.QueryRowContext(ctx, "SELECT e2ee_key_id FROM server_state WHERE id=1").Scan(&configured); err != nil {
		return result, err
	}
	if kind == "bootstrap" {
		if configured.Valid {
			return result, memberError(409, "ALREADY_INITIALIZED")
		}
		if _, err = tx.ExecContext(ctx, "UPDATE server_state SET e2ee_key_id=? WHERE id=1 AND e2ee_key_id IS NULL", input.KeyID); err != nil {
			return result, err
		}
	} else if !configured.Valid || configured.String != input.KeyID {
		return result, memberError(409, "KEY_ID_MISMATCH")
	}
	root, err := s.joiningRootTx(ctx, tx, id)
	if err != nil {
		return result, err
	}
	if err = s.memberBannedTx(ctx, tx, root); err != nil {
		return result, err
	}
	// A group cannot restore a still-banned original identity as a side effect.
	var banned int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM profile_bindings b JOIN ban_subjects bs ON bs.profile_id=b.source_profile_id JOIN ban_actions ba ON ba.ban_id=bs.ban_id WHERE b.target_profile_id=? AND ba.revoked_at IS NULL AND (ba.expires_at IS NULL OR ba.expires_at>?)`, root, s.now().UnixMilli()).Scan(&banned); err != nil {
		return result, err
	}
	if banned > 0 {
		return result, memberError(403, "BANNED")
	}
	if err = s.memberBannedTx(ctx, tx, id.ProfileID); err != nil {
		return result, err
	}
	now := s.now().UnixMilli()
	if _, err = tx.ExecContext(ctx, "INSERT INTO memberships(profile_id,state,joined_at) VALUES(?,'active',?) ON CONFLICT(profile_id) DO UPDATE SET state='active',ended_at=NULL,revision=revision+1", root, now); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE memberships SET state='linked',ended_at=NULL,revision=revision+1 WHERE profile_id IN(SELECT source_profile_id FROM profile_bindings WHERE target_profile_id=?)", root); err != nil {
		return result, err
	}
	role := "member"
	if kind == "bootstrap" {
		role = "admin"
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO profile_roles(profile_id,role_id) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM profile_roles WHERE profile_id=?)", root, role, root); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO profile_controls(profile_id,primary_device_id) VALUES(?,?) ON CONFLICT(profile_id) DO NOTHING", root, id.DeviceID); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE invite_attempts SET state='confirmed',completed_at=? WHERE attempt_id=? AND state='reserved'", now, input.AttemptID); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO invite_redemptions(attempt_id,profile_id,redeemed_at) VALUES(?,?,?)", input.AttemptID, id.ProfileID, now); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE invites SET used_count=used_count+1,encrypted_key_package=CASE WHEN kind='reusable' THEN encrypted_key_package ELSE NULL END WHERE invite_id=?", inviteID); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE server_state SET revision=revision+1 WHERE id=1"); err != nil {
		return result, err
	}
	result, err = s.newSessionTx(ctx, tx, id)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}
