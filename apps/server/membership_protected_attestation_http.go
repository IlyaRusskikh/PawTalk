package main

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

func verifyProtectedPolicyAttestation(ctx context.Context, query access.SessionQuery, signer access.Principal,
	anchor string, view access.PolicyAttestation) error {
	var serverID string
	if err := query.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	key, err := hex.DecodeString(view.SignerKey)
	if err != nil || len(key) != ed25519.PublicKeySize || publicKeyID(key) != signer.DeviceID {
		return memberError(http.StatusForbidden, "INVALID_POLICY_ATTESTATION")
	}
	frame, err := access.PolicyAttestationFrame(serverID, anchor, signer, view)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, frame, view.Signature) {
		return memberError(http.StatusForbidden, "INVALID_POLICY_ATTESTATION")
	}
	return nil
}

func (p *protectedRuntime) readPolicyAttestationHTTP(w http.ResponseWriter, r *http.Request) {
	var revision int64
	if path := r.PathValue("revision"); path != "current" {
		var err error
		revision, err = strconv.ParseInt(path, 10, 64)
		if err != nil || revision < 1 || revision > migrationMaxSafePosition {
			protectedPolicyFail(w, access.InvalidAction)
			return
		}
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchPolicyAttestation(r.Context(), p.resolveSession(memberBearer(r)),
		verifyProtectedPolicyAttestation, revision, func(value access.PolicyAttestation) error {
			return writeProtectedDelivery(w, &sent, value)
		}, access.ScopeAuthorityBinding{ServerID: p.serverID, CutoverDigest: p.cutoverDigest})
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) pendingPolicyAttestationsHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchPendingPolicyAttestations(r.Context(),
		p.resolveSession(memberBearer(r)), func(pending access.PendingPolicyAttestations) error {
			return writeProtectedDelivery(w, &sent, pending)
		}, access.ScopeAuthorityBinding{ServerID: p.serverID, CutoverDigest: p.cutoverDigest})
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) commitPolicyAttestationHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision  int64  `json:"revision"`
		Signature []byte `json:"signature"`
	}
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	err := access.NewStoreWithClock(p.store.db, p.store.now).CommitPolicyAttestation(r.Context(), p.resolveSession(memberBearer(r)),
		verifyProtectedPolicyAttestation, input.Revision, input.Signature,
		access.ScopeAuthorityBinding{ServerID: p.serverID, CutoverDigest: p.cutoverDigest})
	if err != nil {
		policyAttestationFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func policyAttestationFail(w http.ResponseWriter, err error) {
	if errors.Is(err, access.ErrPolicyAttestationUnavailable) {
		err = memberError(http.StatusNotFound, "POLICY_ATTESTATION_UNAVAILABLE")
	}
	protectedPolicyFail(w, err)
}
