package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/hex"
	"net/http"
	"slices"
	"time"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) ownershipStatusHTTP(w http.ResponseWriter, r *http.Request) {
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
	head, err := access.ReadPolicyHead(ctx, tx, &actor)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	_, authority, err := access.ReadScopeAuthorityProofs(ctx, tx, p.serverID, p.cutoverDigest, head.Draft.Revision)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, struct {
		Revision       int64  `json:"revision"`
		PolicyHead     string `json:"policyHead"`
		OwnerProfileID string `json:"ownerProfileId"`
		AuthorityHead  string `json:"authorityHead"`
		SignerDeviceID string `json:"signerDeviceId"`
	}{head.Draft.Revision, head.Digest, authority.OwnerProfileID, authority.Digest, authority.DeviceID})
}

func (p *protectedRuntime) ownershipPreviewHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		TargetProfileID string `json:"targetProfileId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &input); err != nil {
		memberFail(w, err)
		return
	}
	operation, err := randomHex(16)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	ctx := r.Context()
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	offer, err := store.PreviewOwnerTransferOffer(ctx, p.resolveSession(memberBearer(r)), input.TargetProfileID,
		operation, p.store.now().Add(15*time.Minute).UnixMilli())
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	_, authority, err := access.ReadScopeAuthorityProofs(ctx, p.store.db, p.serverID, p.cutoverDigest, offer.HeadRevision)
	if err == nil && (authority.OwnerProfileID != offer.OwnerProfileID || authority.DeviceID != offer.OwnerDeviceID) {
		err = access.MissingGrant
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	offer.Sequence, offer.Previous = authority.Sequence+1, authority.Digest
	respond(w, http.StatusOK, offer)
}

func (p *protectedRuntime) ownershipOfferHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.OwnerTransferOffer
	if _, err := decodeMemberJSON(w, r, 2<<20, &input); err != nil {
		memberFail(w, err)
		return
	}
	offer, err := access.NewStoreWithClock(p.store.db, p.store.now).CreateOwnerTransferOffer(r.Context(),
		p.resolveSession(memberBearer(r)), input, p.verifyOwnershipOffer)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusCreated, offer)
}

func (p *protectedRuntime) ownershipReadHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchOwnerTransferOffer(r.Context(),
		p.resolveSession(memberBearer(r)), func(offer access.OwnerTransferOffer) error {
			if offer.OperationID == "" {
				return writeProtectedDelivery(w, &sent, nil)
			}
			return writeProtectedDelivery(w, &sent, offer)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) ownershipCancelHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		OperationID string `json:"operationId"`
	}
	if _, err := decodeMemberJSON(w, r, 128, &input); err != nil {
		memberFail(w, err)
		return
	}
	err := access.NewStoreWithClock(p.store.db, p.store.now).CancelOwnerTransferOffer(r.Context(), p.resolveSession(memberBearer(r)), input.OperationID)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) ownershipAcceptHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		OperationID string `json:"operationId"`
		DeviceProof string `json:"deviceProof"`
	}
	if _, err := decodeMemberJSON(w, r, 512, &input); err != nil {
		memberFail(w, err)
		return
	}
	if _, err := decodeFixed(input.DeviceProof, ed25519.SignatureSize); err != nil {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	ctx := r.Context()
	var key []byte
	if err := p.store.db.QueryRowContext(ctx, "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		protectedPolicyFail(w, err)
		return
	}
	certify := func(ctx context.Context, query access.SessionQuery, actor access.Principal, offer access.OwnerTransferOffer) (access.ScopeAuthorityLink, error) {
		return p.certifyOwnership(ctx, query, actor, offer, input.DeviceProof)
	}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitOwnerTransfer(ctx,
		p.resolveSession(memberBearer(r)), input.OperationID, b64.EncodeToString(key), certify, signProtectedServerPolicy, verifyProtectedPolicyDraft)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	if proof.Draft.ResourceChange.OwnershipTransfer.DeviceProof != input.DeviceProof {
		protectedPolicyFail(w, access.ErrOwnerTransferUnavailable)
		return
	}
	respond(w, http.StatusOK, struct {
		OperationID    string `json:"operationId"`
		OwnerProfileID string `json:"ownerProfileId"`
		Revision       int64  `json:"revision"`
		Digest         string `json:"digest"`
	}{proof.Draft.OperationID, proof.Draft.ResourceChange.ID, proof.Draft.Revision, proof.Digest})
}

func scopeOwnershipKeys(offer access.OwnerTransferOffer) []string {
	keys := make([]string, 0, len(offer.Candidates))
	for _, candidate := range offer.Candidates {
		keys = append(keys, candidate.SigningKey)
	}
	slices.Sort(keys)
	return keys
}

func (p *protectedRuntime) buildOwnershipOffer(ctx context.Context, query access.SessionQuery, offer access.OwnerTransferOffer) (
	access.ScopeAuthorityContext, access.ScopeAuthorityState, access.ScopeAuthorityLink, error) {
	var binding access.ScopeAuthorityContext
	var empty access.ScopeAuthorityState
	var link access.ScopeAuthorityLink
	reader, ok := query.(access.ScopeAuthorityQuery)
	if !ok {
		return binding, empty, link, access.ErrPolicyConflict
	}
	binding.ServerID, binding.CutoverDigest, binding.AnchorDigest = p.serverID, p.cutoverDigest, p.anchorDigest
	if err := query.QueryRowContext(ctx, `SELECT json_extract(CAST(record AS TEXT),'$.Principal.ProfileID'),
		json_extract(CAST(record AS TEXT),'$.Principal.DeviceID') FROM protected_policy_proofs WHERE revision=1 AND digest=?`, p.anchorDigest).
		Scan(&binding.OwnerProfileID, &binding.OwnerDeviceID); err != nil {
		return binding, empty, link, err
	}
	_, authority, err := access.ReadScopeAuthorityProofs(ctx, reader, p.serverID, p.cutoverDigest, offer.HeadRevision)
	if err != nil {
		return binding, empty, link, err
	}
	if authority.OwnerProfileID != offer.OwnerProfileID || authority.DeviceID != offer.OwnerDeviceID ||
		authority.Sequence+1 != offer.Sequence || authority.Digest != offer.Previous {
		return binding, empty, link, access.ErrPolicyConflict
	}
	root, err := access.ScopeOwnershipCandidatesRoot(scopeOwnershipKeys(offer))
	if err != nil {
		return binding, empty, link, err
	}
	link = access.ScopeAuthorityLink{Action: access.TransferPolicyOwnership, Sequence: offer.Sequence, Previous: offer.Previous,
		Revision: offer.HeadRevision + 1, PolicyHead: offer.PolicyHead, OperationID: offer.OperationID,
		TargetProfileID: offer.TargetProfileID, RecoveryID: offer.RecoveryID, RecoveryKey: offer.RecoveryKey,
		Authorization: offer.Authorization, Transfer: &access.ScopeOwnershipClaim{ExpiresAt: offer.ExpiresAt, CandidatesRoot: root, CutoverDigest: p.cutoverDigest}}
	frame, err := access.ScopeOwnershipOfferFrame(binding, authority.OwnerProfileID, link)
	if err != nil || !validProtectedSigningProof(authority.DeviceKey, frame, offer.Authorization) {
		return binding, empty, link, access.ErrScopeAuthority
	}
	return binding, authority, link, nil
}

func validProtectedSigningProof(encodedKey string, frame []byte, signature string) bool {
	key, keyErr := hex.DecodeString(encodedKey)
	proof, proofErr := decodeFixed(signature, ed25519.SignatureSize)
	return keyErr == nil && proofErr == nil && len(key) == ed25519.PublicKeySize && ed25519.Verify(key, frame, proof)
}

func (p *protectedRuntime) verifyOwnershipOffer(ctx context.Context, query access.SessionQuery, actor access.Principal, offer access.OwnerTransferOffer) error {
	if actor.ProfileID != offer.OwnerProfileID || actor.DeviceID != offer.OwnerDeviceID {
		return access.MissingGrant
	}
	if err := p.verifyOwnershipTarget(ctx, query, offer.TargetProfileID); err != nil {
		return err
	}
	_, _, _, err := p.buildOwnershipOffer(ctx, query, offer)
	return err
}

func (p *protectedRuntime) verifyOwnershipTarget(ctx context.Context, query access.SessionQuery, profile string) error {
	bound, err := p.store.protectedInviteBoundProfile(ctx, query, profile)
	if err == nil && bound != "" {
		return access.Inactive
	}
	return err
}

func (p *protectedRuntime) certifyOwnership(ctx context.Context, query access.SessionQuery, actor access.Principal,
	offer access.OwnerTransferOffer, signature string) (access.ScopeAuthorityLink, error) {
	binding, authority, link, err := p.buildOwnershipOffer(ctx, query, offer)
	if err != nil {
		return link, err
	}
	if actor.ProfileID != offer.TargetProfileID {
		return link, access.MissingGrant
	}
	if err := p.verifyOwnershipTarget(ctx, query, actor.ProfileID); err != nil {
		return link, err
	}
	for _, candidate := range offer.Candidates {
		if candidate.DeviceID == actor.DeviceID {
			link.DeviceKey = candidate.SigningKey
			break
		}
	}
	if !validHexID(link.DeviceKey, 64) {
		return link, access.MissingGrant
	}
	claim, err := access.ScopeOwnershipCandidateClaim(scopeOwnershipKeys(offer), link.DeviceKey, offer.ExpiresAt)
	if err != nil {
		return link, err
	}
	claim.CutoverDigest = p.cutoverDigest
	link.Transfer, link.DeviceProof = &claim, signature
	frame, err := access.ScopeOwnershipAcceptFrame(binding, authority.OwnerProfileID, link)
	if err != nil || !validProtectedSigningProof(link.DeviceKey, frame, signature) {
		return link, access.ErrScopeAuthority
	}
	return link, nil
}

func verifyProtectedOwnershipTransfer(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	reader, ok := query.(access.ScopeAuthorityQuery)
	if !ok {
		return access.ErrPolicyConflict
	}
	if draft.ResourceChange == nil || draft.ResourceChange.OwnershipTransfer == nil || draft.ResourceChange.OwnershipTransfer.Transfer == nil {
		return access.InvalidAction
	}
	var serverID string
	if err := query.QueryRowContext(ctx, `SELECT server_id FROM server_state WHERE id=1`).Scan(&serverID); err != nil {
		return err
	}
	cutover := draft.ResourceChange.OwnershipTransfer.Transfer.CutoverDigest
	return access.VerifyOwnershipScopeAuthority(ctx, reader, serverID, cutover, actor, draft)
}
