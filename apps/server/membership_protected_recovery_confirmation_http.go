package main

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

// Confirmation has to cover every accessible channel and can take several
// bounded deliveries. Its challenge also binds the exact policy and packets.
const protectedRecoveryConfirmationMillis = 3_600_000

type protectedRecoveryConfirmationChallenge struct {
	ServerID       string `json:"serverId"`
	CutoverDigest  string `json:"cutoverDigest"`
	ProfileID      string `json:"profileId"`
	DeviceID       string `json:"deviceId"`
	PolicyHead     string `json:"policyHead"`
	RecoveryID     string `json:"recoveryId"`
	Nonce          string `json:"nonce"`
	ExpiresAt      int64  `json:"expiresAt"`
	ChallengeToken string `json:"challengeToken"`
}

type protectedRecoveryConfirmationInput struct {
	OperationID    string                     `json:"operationId"`
	PolicyHead     string                     `json:"policyHead"`
	RecoveryID     string                     `json:"recoveryId"`
	Nonce          string                     `json:"nonce"`
	ExpiresAt      int64                      `json:"expiresAt"`
	ChallengeToken string                     `json:"challengeToken"`
	Items          []access.RecoveryReadyItem `json:"items"`
	RecoveryProof  string                     `json:"recoveryProof"`
	DeviceProof    string                     `json:"deviceProof"`
}

func recoveryConfirmationMAC(ctx context.Context, query access.SessionQuery, challenge protectedRecoveryConfirmationChallenge) ([]byte, error) {
	var seed []byte
	if err := query.QueryRowContext(ctx, "SELECT identity_seed FROM server_state WHERE id=1").Scan(&seed); err != nil {
		return nil, err
	}
	defer clear(seed)
	if len(seed) != ed25519.SeedSize {
		return nil, memberError(http.StatusServiceUnavailable, "INVALID_SERVER_IDENTITY")
	}
	frame, err := signatureFrame("pawtalk-protected-recovery-confirmation-challenge-v1", challenge.ServerID, challenge.CutoverDigest,
		challenge.ProfileID, challenge.DeviceID, challenge.PolicyHead, challenge.RecoveryID, challenge.Nonce, strconv.FormatInt(challenge.ExpiresAt, 10))
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, seed)
	mac.Write(frame)
	return mac.Sum(nil), nil
}

func (p *protectedRuntime) recoveryConfirmationChallengeHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if _, err := decodeMemberJSON(w, r, 64, &input); err != nil {
		memberFail(w, err)
		return
	}
	ctx := r.Context()
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	defer tx.Rollback()
	actor, err := p.resolveSession(memberBearer(r))(ctx, tx)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	head, err := access.ReadPolicyHead(ctx, tx, &actor)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	now := p.store.now().UnixMilli()
	recovery, err := access.ReadActiveRecoveryIdentity(ctx, tx, actor, now)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	if recovery.ID == "" {
		protectedPolicyFail(w, access.Inactive)
		return
	}
	nonce, err := randomHex(32)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	challenge := protectedRecoveryConfirmationChallenge{ServerID: p.serverID, CutoverDigest: p.cutoverDigest,
		ProfileID: actor.ProfileID, DeviceID: actor.DeviceID, PolicyHead: head.Digest, RecoveryID: recovery.ID,
		Nonce: nonce, ExpiresAt: now + protectedRecoveryConfirmationMillis}
	mac, err := recoveryConfirmationMAC(ctx, tx, challenge)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	challenge.ChallengeToken = b64.EncodeToString(mac)
	respond(w, http.StatusOK, challenge)
}

func recoveryConfirmationFrame(serverID string, actor access.Principal, draft access.PolicyDraft) ([]byte, error) {
	confirmation := draft.ResourceChange.RecoveryConfirmation
	if len(confirmation.Items) > 2000 {
		return nil, access.InvalidAction
	}
	stream := sha256.New()
	domain, err := signatureFrame("pawtalk-protected-recovery-confirmation-items-v1")
	if err != nil {
		return nil, err
	}
	stream.Write(domain)
	for _, item := range confirmation.Items {
		// Framing each item separately preserves the framed byte stream
		// while keeping each call within the signature frame limit.
		part, err := signatureFrame(item.ChannelID, item.Purpose, strconv.FormatUint(item.Generation, 10), item.EpochDigest,
			item.PackageDigest, item.OpeningKey, item.OpeningProof, item.RecoveryProof)
		if err != nil {
			return nil, err
		}
		stream.Write(part)
	}
	return signatureFrame("pawtalk-protected-recovery-confirmation-v1", serverID, confirmation.CutoverDigest,
		actor.ProfileID, actor.DeviceID, draft.OperationID, draft.PreviousDigest, confirmation.RecoveryID,
		confirmation.Nonce, strconv.FormatInt(confirmation.ExpiresAt, 10), hex.EncodeToString(stream.Sum(nil)))
}

func verifyProtectedRecoveryConfirmation(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	invalid := memberError(http.StatusForbidden, "INVALID_PROTECTED_RECOVERY")
	if draft.ResourceChange == nil || draft.ResourceChange.RecoveryConfirmation == nil ||
		draft.ResourceChange.ID != actor.ProfileID {
		return invalid
	}
	confirmation := draft.ResourceChange.RecoveryConfirmation
	recoveryProof, recoveryErr := decodeFixed(confirmation.RecoveryProof, ed25519.SignatureSize)
	deviceProof, deviceErr := decodeFixed(confirmation.DeviceProof, ed25519.SignatureSize)
	if recoveryErr != nil || deviceErr != nil {
		return invalid
	}
	recovery, err := access.ReadRecoveryConfirmationIdentity(ctx, query, actor, draft)
	if err != nil {
		return err
	}
	recoveryKey, err := hex.DecodeString(recovery.SigningKey)
	if err != nil || len(recoveryKey) != ed25519.PublicKeySize || recovery.ID != confirmation.RecoveryID {
		return invalid
	}
	serverID, deviceKey, err := protectedSigner(ctx, query, actor.DeviceID)
	if err != nil {
		return err
	}
	frame, err := recoveryConfirmationFrame(serverID, actor, draft)
	if err != nil {
		return err
	}
	deviceFrame, err := signatureFrame("pawtalk-protected-recovery-confirmation-device-v1", publicKeyID(frame), confirmation.RecoveryProof)
	if err != nil {
		return err
	}
	if !ed25519.Verify(deviceKey, deviceFrame, deviceProof) || !ed25519.Verify(recoveryKey, frame, recoveryProof) {
		return invalid
	}
	return nil
}

func (p *protectedRuntime) confirmRecoveryHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedRecoveryConfirmationInput
	if _, err := decodeMemberJSON(w, r, 2<<20, &input); err != nil {
		memberFail(w, err)
		return
	}
	challengeToken, err := decodeFixed(input.ChallengeToken, sha256.Size)
	if err != nil {
		memberFail(w, memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE"))
		return
	}
	resolve := p.resolveSession(memberBearer(r))
	actor, err := resolve(r.Context(), p.store.db)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	var serverKey []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&serverKey); err != nil {
		protectedPolicyFail(w, err)
		return
	}
	confirmation := &access.RecoveryPolicyConfirmation{RecoveryID: input.RecoveryID, CutoverDigest: p.cutoverDigest,
		ServerKey: b64.EncodeToString(serverKey), Nonce: input.Nonce, ExpiresAt: input.ExpiresAt, Items: input.Items,
		RecoveryProof: input.RecoveryProof, DeviceProof: input.DeviceProof}
	draft := access.PolicyDraft{Action: access.ConfirmPolicyRecovery, OperationID: input.OperationID, PreviousDigest: input.PolicyHead,
		ResourceChange: &access.PolicyResourceChange{ID: actor.ProfileID, RecoveryConfirmation: confirmation}}
	verifyFresh := func(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
		confirmation := draft.ResourceChange.RecoveryConfirmation
		now := p.store.now().UnixMilli()
		if confirmation.ExpiresAt <= now || confirmation.ExpiresAt > now+protectedRecoveryConfirmationMillis {
			return access.ErrRecoveryChallengeExpired
		}
		challenge := protectedRecoveryConfirmationChallenge{ServerID: p.serverID, CutoverDigest: confirmation.CutoverDigest,
			ProfileID: actor.ProfileID, DeviceID: actor.DeviceID, PolicyHead: draft.PreviousDigest, RecoveryID: confirmation.RecoveryID,
			Nonce: confirmation.Nonce, ExpiresAt: confirmation.ExpiresAt}
		expected, err := recoveryConfirmationMAC(ctx, query, challenge)
		if err != nil {
			return err
		}
		if !hmac.Equal(challengeToken, expected) {
			return access.ErrRecoveryChallengeExpired
		}
		return nil
	}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitRecoveryConfirmation(r.Context(), resolve, draft,
		verifyFresh, signProtectedServerPolicy, verifyProtectedPolicyDraft, verifyProtectedEpochSignature)
	switch {
	case errors.Is(err, access.ErrRecoveryChallengeExpired):
		err = memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
	case errors.Is(err, access.ErrRecoveryCoverageChanged):
		err = memberError(http.StatusConflict, "PROTECTED_RECOVERY_COVERAGE_CHANGED")
	case errors.Is(err, access.ErrInvalidRecoveryOpeningProof):
		err = memberError(http.StatusForbidden, "INVALID_PROTECTED_RECOVERY")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, protectedRecoveryReceipt{OperationID: proof.Draft.OperationID,
		RecoveryID: proof.Draft.ResourceChange.RecoveryConfirmation.RecoveryID, Revision: proof.Draft.Revision, Digest: proof.Digest})
}
