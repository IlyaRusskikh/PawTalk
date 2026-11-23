package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"pawtalk/server/internal/access"
)

func protectedInvitationFrame(serverID string, actor access.Principal, input access.InviteCreate, maxUses int64) ([]byte, error) {
	return signatureFrame("pawtalk-protected-invite-v1", serverID, actor.ProfileID, actor.DeviceID, input.PolicyDigest,
		input.ID, input.TokenHash, strconv.FormatInt(input.ExpiresAt, 10), strconv.FormatInt(maxUses, 10))
}

func verifyProtectedInvitation(ctx context.Context, query access.SessionQuery, actor access.Principal, input access.InviteCreate, maxUses int64) error {
	head, err := access.ReadPolicyHead(ctx, query, &actor)
	if err != nil {
		return err
	}
	if head.Digest != input.PolicyDigest {
		return access.ErrPolicyConflict
	}
	return verifyProtectedInvitationSignature(ctx, query, actor, input, maxUses)
}

func verifyProtectedInvitationSignature(ctx context.Context, query access.SessionQuery, actor access.Principal, input access.InviteCreate, maxUses int64) error {
	serverID, key, err := protectedSigner(ctx, query, actor.DeviceID)
	if err != nil {
		return err
	}
	frame, err := protectedInvitationFrame(serverID, actor, input, maxUses)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, frame, input.Signature) {
		return memberError(http.StatusForbidden, "INVALID_PROTECTED_INVITE_SIGNATURE")
	}
	return nil
}

func protectedInviteRedemptionFrame(serverID, cutover string, input access.InviteRedeem) ([]byte, error) {
	return signatureFrame("pawtalk-protected-invite-redeem-v1", serverID, cutover, input.InviteID, input.OperationID,
		input.InvitePublicKey, input.ProfilePublicKey, input.DevicePublicKey, input.AgreementKey, input.Nickname)
}

func verifyInviteApplicantProof(serverID, cutover string, input access.InviteRedeem) (access.InviteApplicant, error) {
	invalid := memberError(http.StatusForbidden, "INVALID_PROTECTED_INVITE_PROOF")
	if !validNickname(input.Nickname) || strings.TrimSpace(input.Nickname) != input.Nickname {
		return access.InviteApplicant{}, access.InvalidAction
	}
	frame, err := protectedInviteRedemptionFrame(serverID, cutover, input)
	if err != nil {
		return access.InviteApplicant{}, access.InvalidAction
	}
	var ids []string
	for _, proof := range [][2]string{{input.InvitePublicKey, input.InviteSignature}, {input.ProfilePublicKey, input.ProfileSignature},
		{input.DevicePublicKey, input.DeviceSignature}} {
		key, keyErr := decodeFixed(proof[0], ed25519.PublicKeySize)
		signature, sigErr := decodeFixed(proof[1], ed25519.SignatureSize)
		if keyErr != nil || sigErr != nil || !ed25519.Verify(key, frame, signature) {
			return access.InviteApplicant{}, invalid
		}
		ids = append(ids, publicKeyID(key))
	}
	if ids[0] == ids[1] || ids[0] == ids[2] || ids[1] == ids[2] {
		return access.InviteApplicant{}, invalid
	}
	return access.InviteApplicant{Principal: access.Principal{ProfileID: ids[1], DeviceID: ids[2]}, TokenHash: ids[0]}, nil
}

func (p *protectedRuntime) verifyInviteApplicant(ctx context.Context, tx access.SessionQuery, input access.InviteRedeem) (access.InviteApplicant, error) {
	applicant, err := verifyInviteApplicantProof(p.serverID, p.cutoverDigest, input)
	if err != nil {
		return access.InviteApplicant{}, err
	}
	var importedProfile string
	err = tx.QueryRowContext(ctx, "SELECT original_profile_id FROM devices WHERE device_id=?", applicant.DeviceID).Scan(&importedProfile)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return access.InviteApplicant{}, err
	}
	if importedProfile != "" && importedProfile != applicant.ProfileID {
		return access.InviteApplicant{}, access.ErrInviteConflict
	}
	applicant.BoundProfile, err = p.store.protectedInviteBoundProfile(ctx, tx, applicant.ProfileID)
	if err != nil {
		return access.InviteApplicant{}, err
	}
	return applicant, nil
}

func (s *membershipStore) protectedInviteBoundProfile(ctx context.Context, query access.SessionQuery, profile string) (string, error) {
	var boundProfile sql.NullString
	err := query.QueryRowContext(ctx, `SELECT COALESCE(json_extract(p.snapshot,'$.ProfileBindings."' || ? || '"'),
		CASE WHEN COALESCE(json_extract(p.snapshot,'$.ImportedProfileBindings'),0)=0 THEN
			COALESCE(json_extract(p.snapshot,'$.ProfileBindings."' || b.target_profile_id || '"'),b.target_profile_id)
		END) FROM protected_policy p LEFT JOIN profile_bindings b ON b.source_profile_id=? WHERE p.id=1`, profile, profile).Scan(&boundProfile)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	effective := profile
	if boundProfile.Valid {
		effective = boundProfile.String
	}
	now := s.now().UnixMilli()
	ban, err := inheritedBanForProfile(ctx, query, effective, now)
	if err != nil || !ban.BannedAt(now) {
		return boundProfile.String, err
	}
	lifted, err := access.ReadInheritedBanLift(ctx, query, effective)
	if err != nil {
		return "", err
	}
	if !lifted {
		denial := protectedRemovalError(ban, true)
		denial.Details["inherited"] = true
		return "", denial
	}
	head, err := access.ReadPolicyHead(ctx, query, nil)
	if err != nil {
		return "", err
	}
	return boundProfile.String, verifyProtectedPolicyDraft(ctx, query, head.Principal, head.Draft)
}

func (p *protectedRuntime) redeemInviteHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.InviteRedeem
	if _, err := decodeMemberJSON(w, r, 4096, &input); err != nil {
		memberFail(w, err)
		return
	}
	var key []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		memberFail(w, err)
		return
	}
	result, err := access.NewStoreWithClock(p.store.db, p.store.now).RedeemInvite(r.Context(), input, p.verifyInviteApplicant,
		verifyProtectedInvitationSignature, verifyProtectedPolicyDraft, &access.InviteEnrollment{
			CutoverDigest: p.cutoverDigest, ServerKey: b64.EncodeToString(key), Sign: signProtectedServerPolicy,
			SignReceipt: signScopedInviteReceipt,
		})
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, result)
}

func protectedServerPolicyFrame(serverID string, actor access.Principal, draft access.PolicyDraft) ([]byte, error) {
	policyFrame, err := protectedPolicyFrame(serverID, actor, draft)
	if err != nil {
		return nil, err
	}
	switch draft.Action {
	case access.EnrollPolicyRecovery:
		return signatureFrame("pawtalk-protected-recovery-enrollment-proof-v1", publicKeyID(policyFrame))
	case access.ConfirmPolicyRecovery:
		return signatureFrame("pawtalk-protected-recovery-confirmation-proof-v1", publicKeyID(policyFrame))
	case access.RecoverPolicyDevice:
		return signatureFrame("pawtalk-protected-recovery-device-proof-v1", publicKeyID(policyFrame))
	case access.TransferPolicyOwnership:
		return signatureFrame("pawtalk-protected-owner-transfer-proof-v1", publicKeyID(policyFrame))
	case access.BindPolicyDevice:
		return signatureFrame("pawtalk-protected-device-bind-proof-v1", publicKeyID(policyFrame))
	case access.LinkPolicyProfiles:
		return signatureFrame("pawtalk-protected-profile-link-proof-v1", publicKeyID(policyFrame))
	case access.UnlinkPolicyProfile:
		return signatureFrame("pawtalk-protected-profile-unlink-proof-v1", publicKeyID(policyFrame))
	case access.MoveScopeDevice:
		return signatureFrame("pawtalk-protected-scope-device-handover-proof-v1", publicKeyID(policyFrame))
	case access.EditScopedChannelSettings:
		return signatureFrame("pawtalk-protected-channel-settings-edit-proof-v1", publicKeyID(policyFrame))
	case access.EditScopedChannelACLRoleRules:
		return signatureFrame("pawtalk-protected-channel-acl-roles-edit-proof-v1", publicKeyID(policyFrame))
	case access.EditScopedChannelACLPersonal:
		return signatureFrame("pawtalk-protected-channel-acl-personal-edit-proof-v1", publicKeyID(policyFrame))
	case access.EditScopedRoles:
		return signatureFrame("pawtalk-protected-roles-edit-proof-v1", publicKeyID(policyFrame))
	case access.RedeemPolicyInvite:
		return signatureFrame("pawtalk-protected-invite-enrollment-v1", publicKeyID(policyFrame))
	case access.LeavePolicyMember:
		return signatureFrame("pawtalk-protected-member-departure-proof-v1", publicKeyID(policyFrame))
	case access.KickPolicyMember, access.BanPolicyMember, access.LiftPolicyMemberBan:
		return signatureFrame("pawtalk-protected-member-moderation-proof-v1", publicKeyID(policyFrame))
	default:
		return nil, access.InvalidAction
	}
}

func protectedPolicyServerKey(draft access.PolicyDraft) string {
	if draft.Action == access.TransferPolicyOwnership {
		return draft.PublicKey
	}
	change := draft.ResourceChange
	if change == nil {
		return ""
	}
	if draft.Action == access.RedeemPolicyInvite && change.Admission != nil {
		return change.Admission.ServerKey
	}
	if draft.Action == access.EnrollPolicyRecovery && change.Recovery != nil {
		return change.Recovery.ServerKey
	}
	if draft.Action == access.ConfirmPolicyRecovery && change.RecoveryConfirmation != nil {
		return change.RecoveryConfirmation.ServerKey
	}
	if draft.Action == access.RecoverPolicyDevice && change.RecoveryDevice != nil {
		return change.RecoveryDevice.ServerKey
	}
	if draft.Action == access.BindPolicyDevice && change.DeviceBinding != nil {
		return change.DeviceBinding.ServerKey
	}
	if draft.Action == access.LinkPolicyProfiles && change.ProfileLink != nil {
		return change.ProfileLink.ServerKey
	}
	if draft.Action == access.UnlinkPolicyProfile && change.ProfileUnlink != nil {
		return change.ProfileUnlink.ServerKey
	}
	if draft.Action == access.MoveScopeDevice && change.ScopeDeviceHandover != nil {
		return change.ScopeDeviceHandover.ServerKey
	}
	if draft.Action == access.EditScopedChannelSettings && change.SettingsEdit != nil {
		return change.SettingsEdit.ServerKey
	}
	if draft.Action == access.EditScopedChannelACLRoleRules && change.ACLRoleEdit != nil {
		return change.ACLRoleEdit.ServerKey
	}
	if draft.Action == access.EditScopedChannelACLPersonal && change.ACLPersonalEdit != nil {
		return change.ACLPersonalEdit.ServerKey
	}
	if draft.Action == access.EditScopedRoles && change.RolesEdit != nil {
		return change.RolesEdit.ServerKey
	}
	if access.IsMemberDepartureAction(draft.Action) && change.Departure != nil {
		return change.Departure.ServerKey
	}
	return ""
}

func signProtectedServerPolicy(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) ([]byte, error) {
	return signProtectedServerEvidence(ctx, query, protectedPolicyServerKey(draft), func(serverID string) ([]byte, error) {
		return protectedServerPolicyFrame(serverID, actor, draft)
	})
}

func signScopedInviteReceipt(ctx context.Context, query access.SessionQuery, receipt access.ScopedInviteReceipt) ([]byte, error) {
	return signProtectedServerEvidence(ctx, query, receipt.Admission.ServerKey, func(serverID string) ([]byte, error) {
		return access.ScopedInviteReceiptFrame(serverID, receipt)
	})
}

func signProtectedServerEvidence(ctx context.Context, query access.SessionQuery, encodedKey string,
	frameFor func(serverID string) ([]byte, error)) ([]byte, error) {
	var serverID string
	var seed []byte
	if err := query.QueryRowContext(ctx, "SELECT server_id,identity_seed FROM server_state WHERE id=1").Scan(&serverID, &seed); err != nil {
		return nil, err
	}
	defer clear(seed)
	if len(seed) != ed25519.SeedSize {
		return nil, memberError(http.StatusServiceUnavailable, "INVALID_SERVER_IDENTITY")
	}
	key := ed25519.NewKeyFromSeed(seed)
	defer clear(key)
	public := key.Public().(ed25519.PublicKey)
	if publicKeyID(public)[:32] != serverID || encodedKey != b64.EncodeToString(public) {
		return nil, memberError(http.StatusServiceUnavailable, "INVALID_SERVER_IDENTITY")
	}
	frame, err := frameFor(serverID)
	if err != nil {
		return nil, err
	}
	return ed25519.Sign(key, frame), nil
}

func verifyProtectedServerPolicy(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	var serverID string
	var key []byte
	if err := query.QueryRowContext(ctx, "SELECT server_id,identity_public_key FROM server_state WHERE id=1").Scan(&serverID, &key); err != nil {
		return err
	}
	if len(key) != ed25519.PublicKeySize || publicKeyID(key)[:32] != serverID ||
		protectedPolicyServerKey(draft) != b64.EncodeToString(key) {
		return memberError(http.StatusForbidden, "INVALID_POLICY_SIGNATURE")
	}
	frame, err := protectedServerPolicyFrame(serverID, actor, draft)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, frame, draft.Signature) {
		return memberError(http.StatusForbidden, "INVALID_POLICY_SIGNATURE")
	}
	return nil
}

func (p *protectedRuntime) inviteAdmissionEvidenceHTTP(w http.ResponseWriter, r *http.Request) {
	device := r.PathValue("device")
	if !validHexID(device, 64) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchOwnerInviteAdmission(r.Context(), p.resolveSession(memberBearer(r)),
		func(query access.SessionQuery) error {
			accepted, err := p.readPendingAdmission(r.Context(), query, device)
			if errors.Is(err, sql.ErrNoRows) {
				return access.ErrInviteUnavailable
			}
			if err != nil {
				return err
			}
			return writeProtectedDelivery(w, &sent, access.PolicyResourceChange{ID: accepted.ProfileID,
				Admission: &access.InvitePolicyAdmission{CutoverDigest: p.cutoverDigest, Claim: accepted.Claim, Issuance: &accepted.Issuance}})
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) createInviteHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.InviteCreate
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	receipt, err := access.NewStoreWithClock(p.store.db, p.store.now).CreateInvite(r.Context(), p.resolveSession(memberBearer(r)), verifyProtectedInvitation, input)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, receipt)
}

func (p *protectedRuntime) listInvitesHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchInvites(r.Context(), p.resolveSession(memberBearer(r)),
		r.URL.Query().Get("before"), func(page access.InvitePage) error { return writeProtectedDelivery(w, &sent, page) })
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) revokeInviteHTTP(w http.ResponseWriter, r *http.Request) {
	err := access.NewStoreWithClock(p.store.db, p.store.now).RevokeInvite(r.Context(), p.resolveSession(memberBearer(r)), r.PathValue("invite"))
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}
