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
	"time"

	"pawtalk/server/internal/access"
)

const deviceBindingLifetime = 15 * time.Minute

type protectedDeviceBindingChallenge struct {
	ServerID           string `json:"serverId"`
	CutoverDigest      string `json:"cutoverDigest"`
	ProfileID          string `json:"profileId"`
	ApproverDeviceID   string `json:"approverDeviceId"`
	PolicyHead         string `json:"policyHead"`
	OperationID        string `json:"operationId"`
	Nonce              string `json:"nonce"`
	ExpiresAt          int64  `json:"expiresAt"`
	ServerAgreementKey string `json:"serverAgreementKey"`
}

type protectedDeviceBindingProposal struct {
	PolicyHead         string `json:"policyHead"`
	OperationID        string `json:"operationId"`
	Nonce              string `json:"nonce"`
	ExpiresAt          int64  `json:"expiresAt"`
	ServerAgreementKey string `json:"serverAgreementKey"`
	SigningKey         string `json:"signingKey"`
	AgreementKey       string `json:"agreementKey"`
	AgreementProof     string `json:"agreementProof"`
	ApplicantProof     string `json:"applicantProof"`
	ApproverProof      string `json:"approverProof"`
}

func deviceBindingChallengeKey(ctx context.Context, query access.SessionQuery, challenge protectedDeviceBindingChallenge) (*ecdh.PrivateKey, error) {
	var seed []byte
	if err := query.QueryRowContext(ctx, "SELECT identity_seed FROM server_state WHERE id=1").Scan(&seed); err != nil {
		return nil, err
	}
	defer clear(seed)
	if len(seed) != ed25519.SeedSize {
		return nil, memberError(http.StatusServiceUnavailable, "INVALID_SERVER_IDENTITY")
	}
	frame, err := signatureFrame("pawtalk-protected-device-bind-challenge-v1", challenge.ServerID, challenge.CutoverDigest,
		challenge.ProfileID, challenge.ApproverDeviceID, challenge.PolicyHead, challenge.OperationID, challenge.Nonce,
		strconv.FormatInt(challenge.ExpiresAt, 10))
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, seed)
	mac.Write(frame)
	material := mac.Sum(nil)
	defer clear(material)
	return ecdh.X25519().NewPrivateKey(material)
}

func (p *protectedRuntime) ownDevicesHTTP(w http.ResponseWriter, r *http.Request) {
	sent := false
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchOwnDevices(r.Context(), p.resolveSession(memberBearer(r)),
		func(ids []string) error {
			if len(ids) > 8192 {
				return memberError(http.StatusServiceUnavailable, "PROTECTED_STATE_UNAVAILABLE")
			}
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, struct {
				DeviceIDs []string `json:"deviceIds"`
			}{ids})
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) deviceBindingChallengeHTTP(w http.ResponseWriter, r *http.Request) {
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
	operationID, err := randomHex(16)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	nonce, err := randomHex(32)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	challenge := protectedDeviceBindingChallenge{ServerID: p.serverID, CutoverDigest: p.cutoverDigest,
		ProfileID: actor.ProfileID, ApproverDeviceID: actor.DeviceID, PolicyHead: head.Digest,
		OperationID: operationID, Nonce: nonce, ExpiresAt: p.store.now().Add(deviceBindingLifetime).UnixMilli()}
	key, err := deviceBindingChallengeKey(ctx, tx, challenge)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	challenge.ServerAgreementKey = publicMigrationAgreementKey(key)
	respond(w, http.StatusOK, challenge)
}

func verifyProtectedDeviceBinding(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	if draft.ResourceChange == nil || draft.ResourceChange.ID != actor.ProfileID || draft.ResourceChange.DeviceBinding == nil {
		return access.InvalidAction
	}
	change := draft.ResourceChange.DeviceBinding
	approver, err := access.ReadDeviceBindingApprover(ctx, query, actor, draft)
	if err != nil {
		return err
	}
	var serverID string
	if err := query.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	invalid := memberError(http.StatusForbidden, "INVALID_DEVICE_BINDING_PROOF")
	challenge := protectedDeviceBindingChallenge{ServerID: serverID, CutoverDigest: change.CutoverDigest,
		ProfileID: actor.ProfileID, ApproverDeviceID: actor.DeviceID, PolicyHead: draft.PreviousDigest, OperationID: draft.OperationID,
		Nonce: change.Nonce, ExpiresAt: change.ExpiresAt, ServerAgreementKey: change.ServerAgreementKey}
	frame, err := signatureFrame("pawtalk-protected-device-bind-v1", serverID, challenge.CutoverDigest,
		challenge.ProfileID, challenge.ApproverDeviceID, challenge.PolicyHead, challenge.OperationID, challenge.Nonce,
		strconv.FormatInt(challenge.ExpiresAt, 10), challenge.ServerAgreementKey, change.SigningKey, change.AgreementKey)
	if err != nil {
		return invalid
	}
	approval, err := signatureFrame("pawtalk-protected-device-bind-approval-v1", publicKeyID(frame), change.ApplicantProof, change.AgreementProof)
	if err != nil || !validProtectedSigningProof(approver.PublicKey, approval, change.ApproverProof) ||
		!validProtectedSigningProof(change.SigningKey, frame, change.ApplicantProof) {
		return invalid
	}
	key, err := deviceBindingChallengeKey(ctx, query, challenge)
	if err != nil {
		return err
	}
	if challenge.ServerAgreementKey != publicMigrationAgreementKey(key) {
		return invalid
	}
	raw, err := hex.DecodeString(change.AgreementKey)
	if err != nil {
		return invalid
	}
	recipient, err := ecdh.X25519().NewPublicKey(raw)
	if err != nil {
		return invalid
	}
	shared, err := key.ECDH(recipient)
	if err != nil {
		return invalid
	}
	defer clear(shared)
	mac := hmac.New(sha256.New, shared)
	mac.Write(frame)
	proof, err := decodeFixed(change.AgreementProof, sha256.Size)
	if err != nil || !hmac.Equal(proof, mac.Sum(nil)) {
		return invalid
	}
	return nil
}

func (p *protectedRuntime) deviceBindingApplyHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedDeviceBindingProposal
	if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
		memberFail(w, err)
		return
	}
	ctx := r.Context()
	resolve := p.resolveSession(memberBearer(r))
	actor, err := resolve(ctx, p.store.db)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	var key []byte
	if err := p.store.db.QueryRowContext(ctx, "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		protectedPolicyFail(w, err)
		return
	}
	draft := access.PolicyDraft{Action: access.BindPolicyDevice, OperationID: input.OperationID, PreviousDigest: input.PolicyHead,
		ResourceChange: &access.PolicyResourceChange{ID: actor.ProfileID, DeviceBinding: &access.PolicyDeviceBinding{
			SigningKey: input.SigningKey, AgreementKey: input.AgreementKey, CutoverDigest: p.cutoverDigest,
			Nonce: input.Nonce, ExpiresAt: input.ExpiresAt, ServerAgreementKey: input.ServerAgreementKey,
			AgreementProof: input.AgreementProof, ApplicantProof: input.ApplicantProof, ApproverProof: input.ApproverProof,
			ServerKey: b64.EncodeToString(key),
		}}}
	verifyIntent := func(ctx context.Context, query access.SessionQuery, principal access.Principal, draft access.PolicyDraft) error {
		if err := verifyProtectedDeviceBinding(ctx, query, principal, draft); err != nil {
			return err
		}
		change := draft.ResourceChange.DeviceBinding
		if change.ExpiresAt > p.store.now().Add(deviceBindingLifetime).UnixMilli() {
			return access.InvalidAction
		}
		applicantKey, _ := hex.DecodeString(change.SigningKey)
		deviceID := publicKeyID(applicantKey)
		if change.RebindAt != 0 {
			source, err := access.ReadDeviceBindingDetachedSource(ctx, query, deviceID)
			if err != nil {
				return err
			}
			if source == "" {
				return access.ErrPolicyConflict
			}
			_, err = p.store.protectedInviteBoundProfile(ctx, query, source)
			return err
		}
		var mapped bool
		if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE device_id=?) OR
			EXISTS(SELECT 1 FROM protected_invite_admissions WHERE device_id=?)`, deviceID, deviceID).Scan(&mapped); err != nil {
			return err
		}
		if mapped {
			return memberError(http.StatusConflict, "DEVICE_BINDING_CONFLICT")
		}
		return nil
	}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitDeviceBinding(ctx,
		resolve, draft, verifyIntent, signProtectedServerPolicy, verifyProtectedPolicyDraft)
	if errors.Is(err, access.ErrRecoveryChallengeExpired) {
		err = memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
	} else if errors.Is(err, access.ErrRecipientKey) {
		err = memberError(http.StatusConflict, "DEVICE_BINDING_CONFLICT")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	applicantKey, _ := hex.DecodeString(proof.Draft.ResourceChange.DeviceBinding.SigningKey)
	respond(w, http.StatusOK, struct {
		OperationID string `json:"operationId"`
		ProfileID   string `json:"profileId"`
		DeviceID    string `json:"deviceId"`
		Revision    int64  `json:"revision"`
		Digest      string `json:"digest"`
	}{proof.Draft.OperationID, proof.Principal.ProfileID, publicKeyID(applicantKey), proof.Draft.Revision, proof.Digest})
}

func (p *protectedRuntime) deviceBindingResultHTTP(w http.ResponseWriter, r *http.Request) {
	operation := r.PathValue("operation")
	if !validHexID(operation, 32) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	ctx := r.Context()
	tx, err := p.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
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
	proof, err := access.ReadDeviceBindingReceipt(ctx, tx, actor, operation)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, access.ErrPolicyConflict) || errors.Is(err, access.Inactive) {
		err = memberError(http.StatusNotFound, "DEVICE_BINDING_RESULT_UNAVAILABLE")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	if err := verifyProtectedPolicyDraft(ctx, tx, proof.Principal, proof.Draft); err != nil {
		protectedPolicyFail(w, err)
		return
	}
	approver, err := access.ReadDeviceBindingApprover(ctx, tx, proof.Principal, proof.Draft)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	binding := proof.Draft.ResourceChange.DeviceBinding
	var effectiveProfile string
	if actor.ProfileID != proof.Principal.ProfileID {
		effectiveProfile = actor.ProfileID
	}
	respond(w, http.StatusOK, struct {
		OperationID        string `json:"operationId"`
		ProfileID          string `json:"profileId"`
		EffectiveProfileID string `json:"effectiveProfileId,omitempty"`
		DeviceID           string `json:"deviceId"`
		Revision           int64  `json:"revision"`
		Digest             string `json:"digest"`
		AgreementKey       string `json:"agreementKey"`
		ApproverSigningKey string `json:"approverSigningKey"`
		ApproverProof      string `json:"approverProof"`
	}{operation, proof.Principal.ProfileID, effectiveProfile, actor.DeviceID, proof.Draft.Revision, proof.Digest, binding.AgreementKey, approver.PublicKey, binding.ApproverProof})
}
