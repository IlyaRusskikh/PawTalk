package main

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

const protectedRecoveryChallengeMillis = 60_000

type protectedRecoveryChallenge struct {
	ServerID           string `json:"serverId"`
	CutoverDigest      string `json:"cutoverDigest"`
	ProfileID          string `json:"profileId"`
	DeviceID           string `json:"deviceId"`
	PolicyHead         string `json:"policyHead"`
	PolicyRevision     int64  `json:"policyRevision"`
	Nonce              string `json:"nonce"`
	ExpiresAt          int64  `json:"expiresAt"`
	ServerAgreementKey string `json:"serverAgreementKey"`
}

type protectedRecoveryProposal struct {
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

type protectedRecoveryReceipt struct {
	OperationID string `json:"operationId"`
	RecoveryID  string `json:"recoveryId"`
	Revision    int64  `json:"revision"`
	Digest      string `json:"digest"`
}

func (p *protectedRuntime) recoveryCoverageHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchRecoveryCoverage(r.Context(), p.resolveSession(memberBearer(r)),
		func(coverage access.RecoveryCoverage) error { return writeProtectedDelivery(w, &sent, coverage) })
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) recoveryPackageHTTP(w http.ResponseWriter, r *http.Request) {
	channel, purpose := r.PathValue("channel"), r.PathValue("purpose")
	if !validHexID(channel, 32) || (purpose != access.LiveEpoch && purpose != access.ArchiveEpoch) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchRecoveryPackage(r.Context(), p.resolveSession(memberBearer(r)),
		channel, purpose, verifyProtectedEpochSignature, &p.textPolicyProofs, true,
		func(delivery access.EpochPackageDelivery) error { return writeProtectedDelivery(w, &sent, delivery) })
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func protectedRecoveryChallengeKey(ctx context.Context, query access.SessionQuery, challenge protectedRecoveryChallenge) (*ecdh.PrivateKey, error) {
	var seed []byte
	if err := query.QueryRowContext(ctx, "SELECT identity_seed FROM server_state WHERE id=1").Scan(&seed); err != nil {
		return nil, err
	}
	defer clear(seed)
	if len(seed) != ed25519.SeedSize {
		return nil, memberError(http.StatusServiceUnavailable, "INVALID_SERVER_IDENTITY")
	}
	frame, err := signatureFrame("pawtalk-protected-recovery-challenge-key-v1", challenge.ServerID, challenge.CutoverDigest,
		challenge.ProfileID, challenge.DeviceID, challenge.PolicyHead, challenge.Nonce, strconv.FormatInt(challenge.ExpiresAt, 10))
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, seed)
	mac.Write(frame)
	material := mac.Sum(nil)
	defer clear(material)
	return ecdh.X25519().NewPrivateKey(material)
}

func (p *protectedRuntime) recoveryEnrollmentChallengeHTTP(w http.ResponseWriter, r *http.Request) {
	// Reject unexpected fields even though issuance requires no client input.
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
	nonce, err := randomHex(32)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	challenge := protectedRecoveryChallenge{ServerID: p.serverID, CutoverDigest: p.cutoverDigest,
		ProfileID: actor.ProfileID, DeviceID: actor.DeviceID, PolicyHead: head.Digest, PolicyRevision: head.Draft.Revision, Nonce: nonce,
		ExpiresAt: p.store.now().UnixMilli() + protectedRecoveryChallengeMillis}
	key, err := protectedRecoveryChallengeKey(ctx, tx, challenge)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	challenge.ServerAgreementKey = publicMigrationAgreementKey(key)
	respond(w, http.StatusOK, challenge)
}

func recoveryIdentityID(serverID, profileID, signingKey, agreementKey string) (string, error) {
	frame, err := signatureFrame("pawtalk-recovery-identity-v1", serverID, profileID, signingKey, agreementKey)
	if err != nil {
		return "", err
	}
	return publicKeyID(frame), nil
}

func runtimeRecoveryChallenge(serverID string, actor access.Principal, draft access.PolicyDraft) protectedRecoveryChallenge {
	change := draft.ResourceChange.Recovery
	return protectedRecoveryChallenge{ServerID: serverID, CutoverDigest: change.CutoverDigest, ProfileID: actor.ProfileID,
		DeviceID: actor.DeviceID, PolicyHead: draft.PreviousDigest, Nonce: change.Nonce, ExpiresAt: change.ExpiresAt,
		ServerAgreementKey: change.ServerAgreementKey}
}

func verifyProtectedRecoveryEnrollment(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	invalid := memberError(http.StatusForbidden, "INVALID_PROTECTED_RECOVERY")
	if draft.ResourceChange == nil || draft.ResourceChange.Recovery == nil || draft.ResourceChange.ID != actor.ProfileID ||
		!validHexID(draft.OperationID, 32) || !validHexID(draft.PreviousDigest, 64) {
		return invalid
	}
	change := draft.ResourceChange.Recovery
	for _, field := range []string{change.CutoverDigest, change.RecoveryID, change.SigningKey, change.AgreementKey, change.Nonce, change.ServerAgreementKey} {
		if !validHexID(field, 64) {
			return invalid
		}
	}
	if change.ExpiresAt <= 0 || change.SigningKey == change.AgreementKey {
		return invalid
	}
	signingKey, _ := hex.DecodeString(change.SigningKey)
	agreementKey, _ := hex.DecodeString(change.AgreementKey)
	signingID := publicKeyID(signingKey)
	if signingID == actor.ProfileID || signingID == actor.DeviceID || littleEndianInteger(agreementKey).Cmp(curve25519Field) >= 0 {
		return invalid
	}
	recoveryProof, recoveryErr := decodeFixed(change.RecoveryProof, ed25519.SignatureSize)
	agreementProof, agreementErr := decodeFixed(change.AgreementProof, sha256.Size)
	deviceProof, deviceErr := decodeFixed(change.DeviceProof, ed25519.SignatureSize)
	if recoveryErr != nil || agreementErr != nil || deviceErr != nil {
		return invalid
	}
	serverID, deviceKey, err := protectedSigner(ctx, query, actor.DeviceID)
	if err != nil {
		return err
	}
	id, err := recoveryIdentityID(serverID, actor.ProfileID, change.SigningKey, change.AgreementKey)
	if err != nil || id != change.RecoveryID {
		return invalid
	}
	transcript, err := signatureFrame("pawtalk-protected-recovery-enrollment-v1", serverID, change.CutoverDigest,
		actor.ProfileID, actor.DeviceID, draft.OperationID, draft.PreviousDigest, change.Nonce,
		strconv.FormatInt(change.ExpiresAt, 10), id, change.SigningKey, change.AgreementKey, change.ServerAgreementKey)
	if err != nil {
		return err
	}
	deviceFrame, err := signatureFrame("pawtalk-protected-recovery-device-v1", publicKeyID(transcript), change.RecoveryProof, change.AgreementProof)
	if err != nil {
		return err
	}
	// Authenticate the active device's approval before using the server's
	// agreement key or verifying an untrusted recovery public key.
	if !ed25519.Verify(deviceKey, deviceFrame, deviceProof) {
		return invalid
	}
	key, err := protectedRecoveryChallengeKey(ctx, query, runtimeRecoveryChallenge(serverID, actor, draft))
	if err != nil {
		return err
	}
	if change.ServerAgreementKey != publicMigrationAgreementKey(key) ||
		!validRecoverySigningKey(signingKey, key) || !ed25519.Verify(signingKey, transcript, recoveryProof) {
		return invalid
	}
	remote, err := ecdh.X25519().NewPublicKey(agreementKey)
	if err != nil {
		return invalid
	}
	shared, err := key.ECDH(remote)
	if err != nil {
		return invalid
	}
	defer clear(shared)
	mac := hmac.New(sha256.New, shared)
	mac.Write(transcript)
	if !hmac.Equal(mac.Sum(nil), agreementProof) {
		return invalid
	}
	return verifyRuntimeRecoveryScopeAuthority(ctx, query, serverID, change.CutoverDigest, actor, draft)
}

func (p *protectedRuntime) enrollRecoveryHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedRecoveryProposal
	if _, err := decodeMemberJSON(w, r, 4096, &input); err != nil {
		memberFail(w, err)
		return
	}
	resolve := p.resolveSession(memberBearer(r))
	var serverKey []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&serverKey); err != nil {
		protectedPolicyFail(w, err)
		return
	}
	actor, err := resolve(r.Context(), p.store.db)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	id, err := recoveryIdentityID(p.serverID, actor.ProfileID, input.SigningKey, input.AgreementKey)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	change := &access.RecoveryPolicyEnrollment{RecoveryID: id, SigningKey: input.SigningKey, AgreementKey: input.AgreementKey,
		CutoverDigest: p.cutoverDigest, ServerKey: b64.EncodeToString(serverKey), Nonce: input.Nonce, ExpiresAt: input.ExpiresAt,
		RecoveryProof: input.RecoveryProof, AgreementProof: input.AgreementProof, DeviceProof: input.DeviceProof, ScopeAuthority: input.ScopeAuthority}
	draft := access.PolicyDraft{Action: access.EnrollPolicyRecovery, OperationID: input.OperationID, PreviousDigest: input.PolicyHead,
		ResourceChange: &access.PolicyResourceChange{ID: actor.ProfileID, Recovery: change}}
	key, err := protectedRecoveryChallengeKey(r.Context(), p.store.db, runtimeRecoveryChallenge(p.serverID, actor, draft))
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	change.ServerAgreementKey = publicMigrationAgreementKey(key)
	verifyFresh := func(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
		now := p.store.now().UnixMilli()
		expires := draft.ResourceChange.Recovery.ExpiresAt
		if expires <= now || expires > now+protectedRecoveryChallengeMillis {
			return memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
		}
		return verifyProtectedRecoveryEnrollment(ctx, query, actor, draft)
	}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitRecoveryEnrollment(r.Context(), resolve, draft,
		verifyFresh, signProtectedServerPolicy, verifyProtectedPolicyDraft)
	switch {
	case errors.Is(err, access.ErrRecoveryChallengeExpired):
		err = memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
	case errors.Is(err, access.ErrRecoveryKeyRetired):
		err = memberError(http.StatusConflict, "PROTECTED_RECOVERY_KIT_RETIRED")
	case errors.Is(err, access.ErrRecipientKey):
		err = memberError(http.StatusConflict, "INVALID_PROTECTED_RECOVERY")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, protectedRecoveryReceipt{OperationID: proof.Draft.OperationID,
		RecoveryID: proof.Draft.ResourceChange.Recovery.RecoveryID, Revision: proof.Draft.Revision, Digest: proof.Digest})
}
