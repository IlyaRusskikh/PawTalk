package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

func verifyProtectedChannelLayout(ctx context.Context, query access.SessionQuery, actor access.Principal, change access.ChannelLayoutChange) error {
	serverID, publicKey, err := protectedSigner(ctx, query, actor.DeviceID)
	if err != nil {
		return err
	}
	frame, err := access.ChannelLayoutFrame(serverID, actor, change)
	if err != nil {
		return err
	}
	if !ed25519.Verify(publicKey, frame, change.Signature) {
		return memberError(http.StatusForbidden, "INVALID_POLICY_SIGNATURE")
	}
	return nil
}

func (p *protectedRuntime) commitChannelLayoutHTTP(w http.ResponseWriter, r *http.Request) {
	var change access.ChannelLayoutChange
	if _, err := decodeMemberJSON(w, r, 2048, &change); err != nil {
		memberFail(w, err)
		return
	}
	receipt, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitChannelLayout(r.Context(),
		p.resolveSession(memberBearer(r)), verifyProtectedChannelLayout, change)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, receipt)
}

func (p *protectedRuntime) channelLayoutEvidenceHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	digest := r.URL.Query().Get("digest")
	if !validHexID(channel, 32) || !validHexID(digest, 64) {
		protectedPolicyFail(w, access.ChannelRestricted)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchChannelLayoutEvidence(r.Context(),
		p.resolveSession(memberBearer(r)), channel, digest, &p.textPolicyProofs, verifyProtectedChannelLayout,
		func(evidence *access.ChannelLayoutEvidence) error { return writeProtectedDelivery(w, &sent, evidence) })
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func protectedPolicyOperation(action string) bool {
	switch action {
	case access.UpdatePolicyRoles, access.UpdateChannelACL, access.UpdateCategoryACL, access.SyncChannelACL, access.MovePolicyChannel,
		access.CreatePolicyChannel, access.EditPolicyChannel, access.CopyPolicyChannel, access.DeletePolicyChannel,
		access.CreatePolicyCategory, access.CopyPolicyCategory, access.RenamePolicyCategory, access.DeletePolicyCategory,
		access.OrderPolicyCategory, access.OrderPolicyChannel, access.AdmitInviteMember, access.ChangeVoiceMute, access.ChangeVoiceDeafen,
		access.RevokePolicyDevice:
		return true
	default:
		return false
	}
}

func (p *protectedRuntime) scopedRoleBasisHTTP(w http.ResponseWriter, r *http.Request) {
	params := r.URL.Query()
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchScopedRoleBasis(r.Context(), p.resolveSession(memberBearer(r)),
		params.Get("channel"), params.Get("profile"), func(basis access.ScopedRoleBasis) error {
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, basis)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) scopedRolePreviewHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.ScopedRoleChange
	if _, err := decodeMemberJSON(w, r, 512<<10, &input); err != nil {
		memberFail(w, err)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchScopedRolePreview(r.Context(), p.resolveSession(memberBearer(r)),
		input, func(preview access.ScopedRolePreview) error { return writeProtectedDelivery(w, &sent, preview) })
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) scopedRoleCommitHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		OperationID string                  `json:"operationId"`
		Change      access.ScopedRoleChange `json:"change"`
		Signature   string                  `json:"signature"`
	}
	if _, err := decodeMemberJSON(w, r, 512<<10, &input); err != nil {
		memberFail(w, err)
		return
	}
	var key []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		memberFail(w, err)
		return
	}
	intent := access.PolicyDraft{Action: access.EditScopedRoles, OperationID: input.OperationID, PreviousDigest: input.Change.PolicyHead,
		ResourceChange: &access.PolicyResourceChange{RolesEdit: &access.ScopedRoleEdit{
			Change: input.Change, CutoverDigest: p.cutoverDigest, EditorProof: input.Signature, ServerKey: b64.EncodeToString(key),
		}}}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitScopedRoleEdit(r.Context(), p.resolveSession(memberBearer(r)),
		intent, signProtectedServerPolicy, verifyProtectedPolicyDraft)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	encodedKey := b64.EncodeToString(key)
	signature, err := signProtectedServerEvidence(r.Context(), p.store.db, encodedKey, func(serverID string) ([]byte, error) {
		return signatureFrame("pawtalk-protected-roles-receipt-v1", serverID, p.cutoverDigest,
			proof.Principal.ProfileID, proof.Principal.DeviceID, proof.Draft.OperationID, proof.Draft.PreviousDigest,
			strconv.FormatInt(proof.Draft.Revision, 10), proof.Digest, input.Signature)
	})
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"operationId": proof.Draft.OperationID, "revision": proof.Draft.Revision, "digest": proof.Digest,
		"serverKey": encodedKey, "signature": b64.EncodeToString(signature)})
}

func (p *protectedRuntime) policyPreviewHTTP(w http.ResponseWriter, r *http.Request) {
	var request access.PolicyDraft
	if _, err := decodeMemberJSON(w, r, 512<<10, &request); err != nil {
		memberFail(w, err)
		return
	}
	if !protectedPolicyOperation(request.Action) || request.Revision != 0 || request.PreviousDigest != "" ||
		request.ResultDigest != "" || len(request.Signature) != 0 {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	resolve := p.resolveSession(memberBearer(r))
	var preview access.PolicyPreview
	var err error
	if projection := r.URL.Query().Get("projection"); projection != "" {
		version, parseErr := strconv.Atoi(projection)
		if parseErr != nil || !access.HasTextRecipientProjection(version) {
			protectedPolicyFail(w, access.InvalidAction)
			return
		}
		if offered := r.URL.Query().Get("maxProjection"); offered != "" {
			maximum, parseErr := strconv.Atoi(offered)
			if parseErr != nil || maximum < version {
				protectedPolicyFail(w, access.InvalidAction)
				return
			}
			version = min(maximum, access.ProfileRoleAuthorityProjectionVersion)
		}
		preview, err = store.PreviewACLPolicyForTransport(r.Context(), resolve, request, version)
	} else {
		preview, err = store.PreviewPolicyForTransport(r.Context(), resolve, request)
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, preview)
}

func (p *protectedRuntime) policyCommitHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		access.PolicyDraft
		ScopeAttestation []byte `json:"scopeAttestation,omitempty"`
	}
	if _, err := decodeMemberJSON(w, r, 512<<10, &input); err != nil {
		memberFail(w, err)
		return
	}
	draft := input.PolicyDraft
	if !protectedPolicyOperation(draft.Action) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	if !validHexID(draft.TextProjectionRoot, 64) || !validHexID(draft.TextProjectionSeed, 64) {
		protectedPolicyFail(w, access.ErrPolicySignatureRequired)
		return
	}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	resolve := p.resolveSession(memberBearer(r))
	var proof access.PolicyProof
	var err error
	verify := verifyProtectedPolicyDraft
	if draft.Action == access.RevokePolicyDevice {
		verify = func(ctx context.Context, query access.SessionQuery, actor access.Principal, entry access.PolicyDraft) error {
			if err := verifyProtectedPolicyDraft(ctx, query, actor, entry); err != nil || entry.Action != access.RevokePolicyDevice {
				return err
			}
			if entry.DeviceChange == nil || entry.DeviceChange.DeviceID == actor.DeviceID {
				return access.InvalidAction
			}
			scopeQuery, ok := query.(access.ScopeAuthorityQuery)
			if !ok {
				return access.ErrScopeAuthority
			}
			_, authority, err := access.ReadScopeAuthorityProofs(ctx, scopeQuery, p.serverID, p.cutoverDigest, entry.Revision-1)
			if err != nil {
				return err
			}
			if entry.DeviceChange.DeviceID == authority.DeviceID {
				return memberError(http.StatusConflict, "PROTECTED_REVOKE_SCOPE_SIGNER")
			}
			return nil
		}
	}
	if input.ScopeAttestation != nil {
		var confirm access.ConfirmInviteAdmission
		if draft.Action == access.AdmitInviteMember {
			confirm = p.confirmInviteAdmission
		}
		proof, err = store.CommitPolicyWithScopeAttestation(r.Context(), resolve, verify,
			draft, confirm, input.ScopeAttestation, verifyProtectedPolicyAttestation)
	} else if draft.Action == access.AdmitInviteMember {
		proof, err = store.CommitInviteAdmissionPolicy(r.Context(), resolve, verifyProtectedPolicyDraft, draft, p.confirmInviteAdmission)
	} else {
		proof, err = store.CommitPolicy(r.Context(), resolve, verify, draft)
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	if (draft.Action == access.ChangeVoiceMute || draft.Action == access.ChangeVoiceDeafen) && draft.ResourceChange != nil {
		p.publishProtectedVoice(draft.ResourceChange.ID)
	}
	respond(w, http.StatusOK, proof)
}

func (p *protectedRuntime) confirmInviteAdmission(ctx context.Context, tx *sql.Tx, proposal access.InvitePolicyAdmission) error {
	if proposal.CutoverDigest != p.cutoverDigest {
		return access.ErrInviteConflict
	}
	applicant, err := verifyInviteApplicantProof(p.serverID, p.cutoverDigest, proposal.Claim)
	if err != nil {
		return err
	}
	accepted, err := p.readPendingAdmission(ctx, tx, applicant.DeviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return access.ErrInviteUnavailable
	}
	if err != nil {
		return err
	}
	if accepted.Claim != proposal.Claim {
		return access.ErrInviteConflict
	}
	if proposal.Issuance == nil || *proposal.Issuance != accepted.Issuance {
		return access.ErrInviteConflict
	}
	return nil
}

func (p *protectedRuntime) managementPolicyProofsHTTP(w http.ResponseWriter, r *http.Request) {
	after := int64(0)
	if r.URL.Query().Has("after") {
		var err error
		after, err = strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		if err != nil || after < 0 {
			protectedPolicyFail(w, access.InvalidAction)
			return
		}
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchManagementPolicyPage(r.Context(), p.resolveSession(memberBearer(r)),
		after, func(page access.PolicyPage) error {
			return writeProtectedDelivery(w, &sent, struct {
				access.PolicyPage
				ImportedRoleNames    map[string]string `json:"importedRoleNames,omitempty"`
				ImportedProfileNames map[string]string `json:"importedProfileNames,omitempty"`
			}{page, p.importedRoleNames, p.importedProfileNames})
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) channelOrderAuthorityHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchChannelOrderAuthority(r.Context(),
		p.resolveSession(memberBearer(r)), channel, &p.textPolicyProofs, func(proof access.ChannelOrderAuthorityProof) error {
			return writeProtectedDelivery(w, &sent, proof)
		})
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) channelSettingsProofHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchChannelSettings(r.Context(), p.resolveSession(memberBearer(r)),
		channel, &p.textPolicyProofs, func(proof access.ChannelSettingsDisclosure) error {
			return writeProtectedDelivery(w, &sent, proof)
		})
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) channelSettingsEditEvidenceHTTP(w http.ResponseWriter, r *http.Request) {
	channel, digest := r.PathValue("channel"), r.URL.Query().Get("digest")
	if !validHexID(channel, 32) || !validHexID(digest, 64) {
		protectedPolicyFail(w, access.ChannelRestricted)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchChannelSettingsEditEvidence(r.Context(),
		p.resolveSession(memberBearer(r)), channel, digest, &p.textPolicyProofs, func(evidence *access.ChannelSettingsEditEvidence) error {
			return writeProtectedDelivery(w, &sent, evidence)
		})
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) commitChannelSettingsHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var input struct {
		OperationID            string                  `json:"operationId"`
		PolicyHead             string                  `json:"policyHead"`
		PreviousSettingsDigest string                  `json:"previousSettingsDigest"`
		Settings               *access.ChannelSettings `json:"settings"`
		EditorProof            string                  `json:"editorProof"`
	}
	if _, err := decodeMemberJSON(w, r, 1<<20, &input); err != nil {
		memberFail(w, err)
		return
	}
	var key []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		memberFail(w, err)
		return
	}
	draft := access.PolicyDraft{Action: access.EditScopedChannelSettings, OperationID: input.OperationID, PreviousDigest: input.PolicyHead,
		ResourceChange: &access.PolicyResourceChange{ID: channel, Settings: input.Settings, SettingsEdit: &access.PolicyChannelSettingsEdit{
			CutoverDigest: p.cutoverDigest, PreviousSettingsDigest: input.PreviousSettingsDigest, EditorProof: input.EditorProof,
			ServerKey: b64.EncodeToString(key),
		}}}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitScopedChannelSettingsEdit(r.Context(), p.resolveSession(memberBearer(r)),
		draft, signProtectedServerPolicy, verifyProtectedPolicyDraft)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"operationId": proof.Draft.OperationID, "revision": proof.Draft.Revision, "digest": proof.Digest})
}

func protectedPolicyFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, access.ErrPolicyConflict):
		err = memberError(http.StatusConflict, "PROTECTED_POLICY_CHANGED")
	case errors.Is(err, access.ErrProfileLinkExpired), errors.Is(err, access.ErrScopeDeviceHandoverExpired):
		err = memberError(http.StatusConflict, "EXPIRED_CHALLENGE")
	case errors.Is(err, access.ErrOwnerTransferUnavailable):
		err = memberError(http.StatusConflict, "PROTECTED_OWNER_TRANSFER_UNAVAILABLE")
	case errors.Is(err, access.ErrScopeAuthority):
		err = memberError(http.StatusForbidden, "INVALID_SCOPE_AUTHORITY")
	case errors.Is(err, access.ErrChannelSettingsEditProof):
		err = memberError(http.StatusForbidden, "INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT")
	case errors.Is(err, access.ErrChannelACLRoleEditProof):
		err = memberError(http.StatusForbidden, "INVALID_PROTECTED_CHANNEL_ACL_EDIT")
	case errors.Is(err, access.ErrChannelACLPersonalEditProof):
		err = memberError(http.StatusForbidden, "INVALID_PROTECTED_CHANNEL_ACL_PERSONAL_EDIT")
	case errors.Is(err, access.ErrScopedRoleSignature):
		err = memberError(http.StatusForbidden, "INVALID_PROTECTED_ROLE_SIGNATURE")
	case errors.Is(err, access.RecoveryRequired):
		failure := &membershipError{Code: "PROTECTED_RECOVERY_REQUIRED", Status: http.StatusConflict}
		var roles access.RoleChangeFailure
		if errors.As(err, &roles) && len(roles.RecoveryProfiles) != 0 {
			failure.Details = map[string]any{"recoveryProfiles": roles.RecoveryProfiles}
		}
		err = failure
	case errors.Is(err, access.EscalationDenied), errors.Is(err, access.HierarchyDenied):
		err = memberError(http.StatusForbidden, "PROTECTED_ACCESS_DENIED")
	case errors.Is(err, access.InvalidPolicy), errors.Is(err, access.WrongScope):
		err = memberError(http.StatusBadRequest, "INVALID_PROTECTED_ACTION")
	}
	protectedRuntimeFail(w, err)
}
