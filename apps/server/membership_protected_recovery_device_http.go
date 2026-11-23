package main

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

type protectedRecoveryDeviceTarget struct {
	ProfileID  string `json:"profileId"`
	RecoveryID string `json:"recoveryId"`
	DeviceID   string `json:"deviceId"`
}

type protectedRecoveryDeviceChallenge struct {
	protectedRecoveryDeviceTarget
	ServerID           string `json:"serverId"`
	CutoverDigest      string `json:"cutoverDigest"`
	PolicyHead         string `json:"policyHead"`
	PolicyRevision     int64  `json:"policyRevision"`
	Nonce              string `json:"nonce"`
	ExpiresAt          int64  `json:"expiresAt"`
	ServerAgreementKey string `json:"serverAgreementKey"`
}

type protectedRecoveryDeviceProposal struct {
	ProfileID      string                     `json:"profileId"`
	RecoveryID     string                     `json:"recoveryId"`
	OperationID    string                     `json:"operationId"`
	PolicyHead     string                     `json:"policyHead"`
	Nonce          string                     `json:"nonce"`
	ExpiresAt      int64                      `json:"expiresAt"`
	SigningKey     string                     `json:"signingKey"`
	AgreementKey   string                     `json:"agreementKey"`
	RecoveryProof  string                     `json:"recoveryProof"`
	AgreementProof string                     `json:"agreementProof"`
	DeviceProof    string                     `json:"deviceProof"`
	ScopeAuthority *access.ScopeAuthorityLink `json:"scopeAuthority,omitempty"`
}

func protectedRecoveryDeviceChallengeKey(ctx context.Context, query access.SessionQuery, challenge protectedRecoveryDeviceChallenge) (*ecdh.PrivateKey, error) {
	var seed []byte
	if err := query.QueryRowContext(ctx, "SELECT identity_seed FROM server_state WHERE id=1").Scan(&seed); err != nil {
		return nil, err
	}
	defer clear(seed)
	if len(seed) != ed25519.SeedSize {
		return nil, memberError(http.StatusServiceUnavailable, "INVALID_SERVER_IDENTITY")
	}
	frame, err := signatureFrame("pawtalk-protected-recovery-device-challenge-key-v1", challenge.ServerID, challenge.CutoverDigest,
		challenge.ProfileID, challenge.DeviceID, challenge.RecoveryID, challenge.PolicyHead, challenge.Nonce, strconv.FormatInt(challenge.ExpiresAt, 10))
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, seed)
	mac.Write(frame)
	material := mac.Sum(nil)
	defer clear(material)
	return ecdh.X25519().NewPrivateKey(material)
}

func (p *protectedRuntime) recoveryDeviceChallengeHTTP(w http.ResponseWriter, r *http.Request) {
	var target protectedRecoveryDeviceTarget
	if _, err := decodeMemberJSON(w, r, 512, &target); err != nil {
		memberFail(w, err)
		return
	}
	if !validHexID(target.ProfileID, 64) || !validHexID(target.DeviceID, 64) || !validHexID(target.RecoveryID, 64) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	ctx := r.Context()
	tx, err := p.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	defer tx.Rollback()
	head, err := access.ReadPolicyHead(ctx, tx, nil)
	if err == nil {
		err = verifyProtectedPolicyDraft(ctx, tx, head.Principal, head.Draft)
	}
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	nonce, err := randomHex(32)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	// Issuance takes the same path for unknown and existing profiles. Only
	// submission verifies which profile and recovery identity currently exist.
	challenge := protectedRecoveryDeviceChallenge{protectedRecoveryDeviceTarget: target,
		ServerID: p.serverID, CutoverDigest: p.cutoverDigest, PolicyHead: head.Digest, PolicyRevision: head.Draft.Revision,
		Nonce: nonce, ExpiresAt: p.store.now().UnixMilli() + protectedRecoveryChallengeMillis}
	key, err := protectedRecoveryDeviceChallengeKey(ctx, tx, challenge)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	challenge.ServerAgreementKey = b64.EncodeToString(key.PublicKey().Bytes())
	respond(w, http.StatusOK, challenge)
}

func protectedRecoveryDeviceIntentFrame(challenge protectedRecoveryDeviceChallenge, operationID, signingKey, agreementKey string) ([]byte, error) {
	return signatureFrame("pawtalk-protected-recovery-device-v1", challenge.ServerID, challenge.CutoverDigest,
		challenge.ProfileID, challenge.DeviceID, challenge.RecoveryID, challenge.PolicyHead, operationID, challenge.Nonce,
		strconv.FormatInt(challenge.ExpiresAt, 10), signingKey, agreementKey)
}

func verifyProtectedRecoveryDevice(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	if draft.ResourceChange == nil || draft.ResourceChange.ID != actor.ProfileID || draft.ResourceChange.RecoveryDevice == nil {
		return access.InvalidAction
	}
	proposal := draft.ResourceChange.RecoveryDevice
	invalid := memberError(http.StatusForbidden, "INVALID_RECOVERY_DEVICE_PROOF")
	var identity access.RecoveryIdentity
	var err error
	if draft.Revision == 0 {
		identity, err = access.ReadRecoveryDeviceTarget(ctx, query, actor.ProfileID, 0)
	} else {
		identity, err = access.ReadRecoveryDeviceIdentity(ctx, query, actor, draft)
	}
	if err != nil || identity.ID != proposal.RecoveryID {
		return invalid
	}
	var serverID string
	if err := query.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	challenge := protectedRecoveryDeviceChallenge{
		protectedRecoveryDeviceTarget: protectedRecoveryDeviceTarget{actor.ProfileID, identity.ID, actor.DeviceID},
		ServerID:                      serverID, CutoverDigest: proposal.CutoverDigest, PolicyHead: draft.PreviousDigest,
		Nonce: proposal.Nonce, ExpiresAt: proposal.ExpiresAt,
	}
	frame, err := protectedRecoveryDeviceIntentFrame(challenge, draft.OperationID, proposal.SigningKey, proposal.AgreementKey)
	if err != nil {
		return access.InvalidAction
	}
	for _, proof := range [][2]string{{identity.SigningKey, proposal.RecoveryProof}, {proposal.SigningKey, proposal.DeviceProof}} {
		key, keyErr := hex.DecodeString(proof[0])
		signature, proofErr := decodeFixed(proof[1], ed25519.SignatureSize)
		if keyErr != nil || proofErr != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, frame, signature) {
			return invalid
		}
	}
	deviceKey, _ := hex.DecodeString(proposal.SigningKey)
	if publicKeyID(deviceKey) != actor.DeviceID {
		return invalid
	}
	key, err := protectedRecoveryDeviceChallengeKey(ctx, query, challenge)
	if err != nil {
		return err
	}
	agreementRaw, err := hex.DecodeString(proposal.AgreementKey)
	if err != nil {
		return invalid
	}
	agreement, err := ecdh.X25519().NewPublicKey(agreementRaw)
	if err != nil {
		return invalid
	}
	shared, err := key.ECDH(agreement)
	if err != nil {
		return invalid
	}
	defer clear(shared)
	mac := hmac.New(sha256.New, shared)
	mac.Write(frame)
	proof, err := decodeFixed(proposal.AgreementProof, sha256.Size)
	if err != nil || !hmac.Equal(proof, mac.Sum(nil)) {
		return invalid
	}
	return verifyRuntimeRecoveryScopeAuthority(ctx, query, serverID, proposal.CutoverDigest, actor, draft)
}

func (p *protectedRuntime) recoverDeviceHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedRecoveryDeviceProposal
	if _, err := decodeMemberJSON(w, r, 4096, &input); err != nil {
		memberFail(w, err)
		return
	}
	ctx := r.Context()
	var key []byte
	if err := p.store.db.QueryRowContext(ctx, "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	intent := access.PolicyDraft{Action: access.RecoverPolicyDevice, OperationID: input.OperationID, PreviousDigest: input.PolicyHead,
		ResourceChange: &access.PolicyResourceChange{ID: input.ProfileID, RecoveryDevice: &access.RecoveryPolicyDevice{
			RecoveryID: input.RecoveryID, CutoverDigest: p.cutoverDigest, ServerKey: b64.EncodeToString(key), Nonce: input.Nonce,
			ExpiresAt: input.ExpiresAt, SigningKey: input.SigningKey, AgreementKey: input.AgreementKey,
			RecoveryProof: input.RecoveryProof, AgreementProof: input.AgreementProof, DeviceProof: input.DeviceProof, ScopeAuthority: input.ScopeAuthority,
		}}}
	verifyIntent := func(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
		if err := verifyProtectedRecoveryDevice(ctx, query, actor, draft); err != nil {
			return err
		}
		bound, err := p.store.protectedInviteBoundProfile(ctx, query, actor.ProfileID)
		if err == nil && bound != "" {
			return access.Inactive
		}
		return err
	}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitRecoveryDevice(ctx, intent,
		verifyIntent, signProtectedServerPolicy, verifyProtectedPolicyDraft, p.invalidateRecoveredDeviceSessions)
	var ban access.MemberBanError
	switch {
	case errors.Is(err, access.ErrPolicyConflict):
		err = memberError(http.StatusConflict, "RECOVERY_DEVICE_CHANGED")
	case errors.Is(err, access.ErrRecoveryChallengeExpired):
		err = memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
	case errors.Is(err, access.ErrRecipientKey), errors.Is(err, access.Inactive), errors.Is(err, access.RecoveryRequired), errors.As(err, &ban):
		err = memberError(http.StatusForbidden, "INVALID_RECOVERY_DEVICE_PROOF")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, protectedRecoveryReceipt{OperationID: input.OperationID, RecoveryID: input.RecoveryID,
		Revision: proof.Draft.Revision, Digest: proof.Digest})
}

func (p *protectedRuntime) invalidateRecoveredDeviceSessions(ctx context.Context, tx *sql.Tx, actor access.Principal) error {
	const retiredDevices = `SELECT d.key FROM protected_policy p, json_each(p.snapshot,'$.PolicyDevices') d
		WHERE p.id=1 AND json_extract(d.value,'$.ProfileID')=? AND json_extract(d.value,'$.Revoked')=1`
	now := p.store.now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `DELETE FROM protected_runtime_sessions WHERE device_id IN (`+retiredDevices+`)`, actor.ProfileID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE protected_voice_slots SET grant_digest='',disconnect_pending=1
		WHERE profile_id=? AND device_id<>? AND (active_until>? OR disconnect_pending=1)`, actor.ProfileID, actor.DeviceID, now)
	return err
}
