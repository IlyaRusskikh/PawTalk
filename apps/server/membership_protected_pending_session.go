package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"pawtalk/server/internal/access"
)

const pendingInviteSessionLifetime = 15 * time.Minute

func protectedPendingSessionFrame(serverID, cutover, binding, nonce, profileID, deviceID string) ([]byte, error) {
	return signatureFrame("pawtalk-protected-pending-session-v1", serverID, cutover, binding, nonce, profileID, deviceID)
}

func (p *protectedRuntime) readPendingAdmission(ctx context.Context, tx access.SessionQuery, deviceID string) (access.PendingInviteAdmission, error) {
	return access.ReadPendingInviteAdmission(ctx, tx, deviceID, p.store.now().UnixMilli(), p.verifyInviteApplicant,
		verifyProtectedInvitationSignature, verifyProtectedPolicyDraft)
}

func (p *protectedRuntime) openPendingInviteSession(ctx context.Context, input protectedSessionRequest) (protectedSessionReceipt, error) {
	var result protectedSessionReceipt
	invalid := memberError(http.StatusUnauthorized, "INVALID_PROTECTED_SESSION_PROOF")
	if !validHexID(input.DeviceID, 64) || !validHexID(input.Nonce, 64) {
		return result, invalid
	}
	signature, err := decodeFixed(input.Signature, ed25519.SignatureSize)
	if err != nil {
		return result, invalid
	}
	p.mu.Lock()
	deadline := p.challenges[input.Nonce]
	p.mu.Unlock()
	expired := memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
	if deadline <= p.store.now().UnixMilli() {
		return result, expired
	}
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	admission, err := p.readPendingAdmission(ctx, tx, input.DeviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return result, invalid
	}
	if err != nil {
		return result, err
	}
	key, err := decodeFixed(admission.DevicePublicKey, ed25519.PublicKeySize)
	if err != nil || publicKeyID(key) != input.DeviceID {
		return result, invalid
	}
	frame, err := protectedPendingSessionFrame(p.serverID, p.cutoverDigest, p.store.protectedBinding, input.Nonce, admission.ProfileID, input.DeviceID)
	if err != nil || !ed25519.Verify(key, frame, signature) {
		return result, invalid
	}
	p.mu.Lock()
	current := p.challenges[input.Nonce]
	delete(p.challenges, input.Nonce)
	p.mu.Unlock()
	now := p.store.now().UnixMilli()
	if current != deadline || current <= now {
		return result, expired
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_pending_invite_sessions WHERE expires_at<=?", now); err != nil {
		return result, err
	}
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM protected_pending_invite_sessions WHERE device_id=? AND binding=?",
		input.DeviceID, p.store.protectedBinding).Scan(&count); err != nil {
		return result, err
	}
	if count >= 16 {
		return result, memberError(http.StatusTooManyRequests, "PROTECTED_SESSION_LIMIT")
	}
	token, raw, err := randomToken()
	if err != nil {
		return result, err
	}
	defer clear(raw)
	sessionID, err := randomHex(16)
	if err != nil {
		return result, err
	}
	hash := sha256.Sum256(raw)
	ends := now + pendingInviteSessionLifetime.Milliseconds()
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_pending_invite_sessions(session_id,device_id,token_hash,binding,expires_at)
		VALUES(?,?,?,?,?)`, sessionID, input.DeviceID, hash[:], p.store.protectedBinding, ends); err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return protectedSessionReceipt{Token: token, SessionID: sessionID, ProfileID: admission.ProfileID, DeviceID: input.DeviceID, ExpiresAt: ends}, nil
}

func (p *protectedRuntime) openPendingInviteSessionHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedSessionRequest
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	result, err := p.openPendingInviteSession(r.Context(), input)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusCreated, result)
}

func (p *protectedRuntime) pendingInviteStateHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	invalid := memberError(http.StatusUnauthorized, "INVALID_PROTECTED_SESSION")
	raw, err := decodeFixed(memberBearer(r), 32)
	if err != nil {
		memberFail(w, invalid)
		return
	}
	token := sha256.Sum256(raw)
	clear(raw)
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	defer tx.Rollback()
	var device string
	err = tx.QueryRowContext(ctx, `SELECT device_id FROM protected_pending_invite_sessions WHERE token_hash=? AND binding=? AND expires_at>?`,
		token[:], p.store.protectedBinding, p.store.now().UnixMilli()).Scan(&device)
	if errors.Is(err, sql.ErrNoRows) {
		memberFail(w, invalid)
		return
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	admission, err := p.readPendingAdmission(ctx, tx, device)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	var sent bool
	if err := writeProtectedDelivery(w, &sent, admission); err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}
