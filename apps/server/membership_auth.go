package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type membershipError struct {
	Code    string
	Status  int
	Details map[string]any
}

func (e *membershipError) Error() string        { return e.Code }
func memberError(status int, code string) error { return &membershipError{Code: code, Status: status} }

type memberIdentity struct {
	ProfileID string `json:"profileId"`
	DeviceID  string `json:"deviceId"`
}
type memberAccess struct {
	memberIdentity
	EffectiveProfileID string   `json:"effectiveProfileId"`
	SessionID          string   `json:"-"`
	Role               string   `json:"role"`
	Permissions        []string `json:"permissions"`
}

func (a memberAccess) allows(permission string) bool {
	for _, p := range a.Permissions {
		if p == permission {
			return true
		}
	}
	return false
}

type memberChallenge struct {
	Challenge string `json:"challenge"`
	Nonce     string `json:"nonce"`
	ExpiresAt int64  `json:"expiresAt"`
	ServerID  string `json:"serverId"`
}

func randomToken() (string, []byte, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", nil, err
	}
	return base64.RawURLEncoding.EncodeToString(data), data, nil
}

func (s *membershipStore) challenge(ctx context.Context) (memberChallenge, error) {
	var result memberChallenge
	id, err := randomHex(16)
	if err != nil {
		return result, err
	}
	encoded, nonce, err := randomToken()
	if err != nil {
		return result, err
	}
	now := s.now().UnixMilli()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM auth_challenges WHERE expires_at<=?", now); err != nil {
		return result, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM auth_challenges").Scan(&count); err != nil {
		return result, err
	}
	if count >= 4096 {
		return result, memberError(429, "CHALLENGE_LIMIT")
	}
	result = memberChallenge{Challenge: id, Nonce: encoded, ExpiresAt: now + membershipChallengeSeconds*1000}
	if err = tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&result.ServerID); err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO auth_challenges(challenge_id,nonce,expires_at) VALUES(?,?,?)", id, nonce, result.ExpiresAt); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func validMemberLabel(name string) bool {
	return utf8.ValidString(name) && utf8.RuneCountInString(name) >= 1 && utf8.RuneCountInString(name) <= 64 && strings.IndexFunc(name, unicode.IsControl) < 0
}

// proveDevice authenticates a request, not membership. Callers may only allow new
// identities after validating an invitation or a bounded link request.
func (s *membershipStore) proveDevice(ctx context.Context, proof membershipProof, method, uri string, body []byte, nickname, label string, allowNew bool) (memberIdentity, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return memberIdentity{}, err
	}
	defer tx.Rollback()
	identity, err := s.proveDeviceTx(ctx, tx, proof, method, uri, body, nickname, label, allowNew)
	if err != nil {
		return identity, err
	}
	return identity, tx.Commit()
}

func (s *membershipStore) proveDeviceTx(ctx context.Context, tx *sql.Tx, proof membershipProof, method, uri string, body []byte, nickname, label string, allowNew bool) (memberIdentity, error) {
	var result memberIdentity
	if len(proof.Challenge) != 32 {
		return result, memberError(401, "INVALID_PROOF")
	}
	var nonce []byte
	var expires int64
	var used sql.NullInt64
	var serverID string
	err := tx.QueryRowContext(ctx, "SELECT nonce,expires_at,used_at FROM auth_challenges WHERE challenge_id=?", proof.Challenge).Scan(&nonce, &expires, &used)
	if errors.Is(err, sql.ErrNoRows) {
		return result, memberError(401, "EXPIRED_CHALLENGE")
	}
	if err != nil {
		return result, err
	}
	if used.Valid || expires <= s.now().UnixMilli() {
		return result, memberError(401, "EXPIRED_CHALLENGE")
	}
	if err = tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return result, err
	}
	if err = proof.verify(serverID, method, uri, nonce, body); err != nil {
		return result, memberError(401, "INVALID_PROOF")
	}
	root, device, certificate, err := proof.keys()
	if err != nil {
		return result, memberError(401, "INVALID_PROOF")
	}
	result = memberIdentity{ProfileID: publicKeyID(root), DeviceID: publicKeyID(device)}
	var existing string
	err = tx.QueryRowContext(ctx, "SELECT original_profile_id FROM devices WHERE device_id=?", result.DeviceID).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		if !allowNew {
			return result, memberError(403, "NOT_A_MEMBER")
		}
		nickname, label = strings.TrimSpace(nickname), strings.TrimSpace(label)
		if !validNickname(nickname) || !validMemberLabel(label) {
			return result, memberError(400, "INVALID_PROFILE")
		}
		now := s.now().UnixMilli()
		if _, err = tx.ExecContext(ctx, "INSERT INTO profiles(profile_id,identity_public_key,nickname,created_at) VALUES(?,?,?,?)", result.ProfileID, root, nickname, now); err != nil {
			return result, memberError(409, "IDENTITY_CONFLICT")
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO devices(device_id,original_profile_id,signing_public_key,label,identity_certificate,created_at) VALUES(?,?,?,?,?,?)", result.DeviceID, result.ProfileID, device, label, certificate, now); err != nil {
			return result, memberError(409, "IDENTITY_CONFLICT")
		}
	} else if err != nil {
		return result, err
	} else if existing != result.ProfileID {
		return result, memberError(401, "INVALID_PROOF")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE auth_challenges SET used_at=? WHERE challenge_id=? AND used_at IS NULL", s.now().UnixMilli(), proof.Challenge); err != nil {
		return result, err
	}
	return result, nil
}

type membershipIdentityQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *membershipStore) resolveIdentity(ctx context.Context, query membershipIdentityQuery, id memberIdentity) (memberAccess, error) {
	return s.resolveLegacyIdentity(ctx, query, id, false)
}

func (s *membershipStore) resolveLegacyIdentity(ctx context.Context, query membershipIdentityQuery, id memberIdentity, skipLegacyBan bool) (memberAccess, error) {
	access := memberAccess{memberIdentity: id, EffectiveProfileID: id.ProfileID, Permissions: []string{}}
	var target string
	err := query.QueryRowContext(ctx, "SELECT target_profile_id FROM profile_bindings WHERE source_profile_id=?", id.ProfileID).Scan(&target)
	if err == nil {
		access.EffectiveProfileID = target
	} else if !errors.Is(err, sql.ErrNoRows) {
		return access, err
	}
	var state, originalState string
	err = query.QueryRowContext(ctx, "SELECT state FROM memberships WHERE profile_id=?", access.EffectiveProfileID).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return access, memberError(403, "NOT_A_MEMBER")
	}
	if err != nil {
		return access, err
	}
	if !skipLegacyBan {
		var banUntil sql.NullInt64
		err = query.QueryRowContext(ctx, `SELECT a.expires_at FROM ban_subjects b JOIN ban_actions a ON a.ban_id=b.ban_id
        WHERE b.profile_id IN (?,?) AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?)
        ORDER BY CASE WHEN a.expires_at IS NULL THEN 1 ELSE 0 END DESC,a.expires_at DESC LIMIT 1`, id.ProfileID, access.EffectiveProfileID, s.now().UnixMilli()).Scan(&banUntil)
		if err == nil {
			var expires any
			if banUntil.Valid {
				expires = banUntil.Int64
			}
			return access, &membershipError{Code: "BANNED", Status: 403, Details: map[string]any{"expiresAt": expires}}
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return access, err
		}
	}
	if state != "active" {
		return access, &membershipError{Code: "NOT_A_MEMBER", Status: 403, Details: map[string]any{"membershipState": state}}
	}
	if access.EffectiveProfileID != id.ProfileID {
		if err = query.QueryRowContext(ctx, "SELECT state FROM memberships WHERE profile_id=?", id.ProfileID).Scan(&originalState); errors.Is(err, sql.ErrNoRows) {
			return access, memberError(403, "NOT_A_MEMBER")
		}
		if err != nil {
			return access, err
		}
		if originalState != "linked" {
			return access, memberError(403, "NOT_A_MEMBER")
		}
	}
	return access, nil
}

func (s *membershipStore) resolveAccessTx(ctx context.Context, tx *sql.Tx, id memberIdentity) (memberAccess, error) {
	access, err := s.resolveIdentity(ctx, tx, id)
	if err != nil {
		return access, err
	}
	return loadLegacyRoles(ctx, tx, access)
}

func loadLegacyRoles(ctx context.Context, tx *sql.Tx, access memberAccess) (memberAccess, error) {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT p.permission FROM effective_profile_roles r JOIN role_permissions p ON p.role_id=r.role_id WHERE r.profile_id=? ORDER BY p.permission`, access.EffectiveProfileID)
	if err != nil {
		return access, err
	}
	for rows.Next() {
		var p string
		if err = rows.Scan(&p); err != nil {
			rows.Close()
			return access, err
		}
		access.Permissions = append(access.Permissions, p)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return access, err
	}
	rows.Close()
	var rank int
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(CASE r.system_kind WHEN 'admin' THEN 3 WHEN 'moderator' THEN 2 ELSE 1 END),1) FROM effective_profile_roles p JOIN roles r ON r.role_id=p.role_id WHERE p.profile_id=?`, access.EffectiveProfileID).Scan(&rank)
	if err != nil {
		return access, err
	}
	access.Role = map[int]string{1: "member", 2: "moderator", 3: "admin"}[rank]
	return access, nil
}

type memberSession struct {
	Token     string       `json:"sessionToken"`
	ExpiresAt int64        `json:"expiresAt"`
	Access    memberAccess `json:"self"`
}

func (s *membershipStore) newSessionTx(ctx context.Context, tx *sql.Tx, id memberIdentity) (memberSession, error) {
	var result memberSession
	access, err := s.resolveAccessTx(ctx, tx, id)
	if err != nil {
		return result, err
	}
	var count int
	now := s.now().UnixMilli()
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM sessions WHERE device_id=? AND revoked_at IS NULL AND expires_at>?", id.DeviceID, now).Scan(&count); err != nil {
		return result, err
	}
	if count >= 16 {
		// Repeated application restarts must not lock a legitimate installation
		// out for the full session lifetime. Keep its active voice session, evict
		// oldest non-media sessions; every new session still requires a signature.
		_, err = tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=? WHERE session_id IN
		 (SELECT s.session_id FROM sessions s WHERE s.device_id=? AND s.revoked_at IS NULL AND s.expires_at>?
		 AND NOT EXISTS(SELECT 1 FROM voice_slots v WHERE v.session_id=s.session_id AND v.expires_at>?)
		 ORDER BY s.created_at,s.session_id LIMIT ?)`, now, id.DeviceID, now, now, count-15)
		if err != nil {
			return result, err
		}
	}
	token, raw, err := randomToken()
	if err != nil {
		return result, err
	}
	sessionID, err := randomHex(16)
	if err != nil {
		return result, err
	}
	hash := sha256.Sum256(raw)
	expires := now + membershipSessionSeconds*1000
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions(session_id,device_id,token_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)", sessionID, id.DeviceID, hash[:], now, expires, now); err != nil {
		return result, err
	}
	access.SessionID = sessionID
	return memberSession{Token: token, ExpiresAt: expires, Access: access}, nil
}

func (s *membershipStore) sessionAccessTx(ctx context.Context, tx *sql.Tx, token string) (memberAccess, error) {
	identity, err := s.sessionIdentity(ctx, tx, token)
	if err != nil {
		return identity, err
	}
	return loadLegacyRoles(ctx, tx, identity)
}

func (s *membershipStore) sessionIdentity(ctx context.Context, query membershipIdentityQuery, token string) (memberAccess, error) {
	var result memberAccess
	raw, err := decodeFixed(token, 32)
	if err != nil {
		return result, memberError(401, "INVALID_SESSION")
	}
	hash := sha256.Sum256(raw)
	var id memberIdentity
	var sessionID string
	err = query.QueryRowContext(ctx, `SELECT s.session_id,s.device_id,d.original_profile_id FROM sessions s JOIN devices d ON d.device_id=s.device_id
        WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`, hash[:], s.now().UnixMilli()).Scan(&sessionID, &id.DeviceID, &id.ProfileID)
	if errors.Is(err, sql.ErrNoRows) {
		return result, memberError(401, "INVALID_SESSION")
	}
	if err != nil {
		return result, err
	}
	result, err = s.resolveIdentity(ctx, query, id)
	result.SessionID = sessionID
	return result, err
}

func (s *membershipStore) session(ctx context.Context, proof membershipProof, method, uri string, body []byte) (memberSession, error) {
	var result memberSession
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	id, err := s.proveDeviceTx(ctx, tx, proof, method, uri, body, "", "", false)
	if err != nil {
		return result, err
	}
	result, err = s.newSessionTx(ctx, tx, id)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

// force a consistent UTC millisecond clock for all lifecycle checks.
func memberDeadline(now time.Time, seconds int64) int64 { return now.UnixMilli() + seconds*1000 }
