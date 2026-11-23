package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"net/http"
	"slices"
	"strconv"
	"time"

	"pawtalk/server/internal/access"
)

const profileLinkConsentLifetime = 15 * time.Minute

func (p *protectedRuntime) profileLinkStatusHTTP(w http.ResponseWriter, r *http.Request) {
	status, err := access.NewStoreWithClock(p.store.db, p.store.now).ReadProfileLinkStatus(r.Context(), p.resolveSession(memberBearer(r)))
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, status)
}

type protectedProfileLinkPreviewRequest struct {
	ProfileID string `json:"profileId"`
	DeviceID  string `json:"deviceId"`
	PrimaryID string `json:"primaryId"`
	ExpiresAt int64  `json:"expiresAt"`
	Proof     string `json:"proof"`
}

func (p *protectedRuntime) previewProfileLinkHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedProfileLinkPreviewRequest
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	if !validHexID(input.ProfileID, 64) || !validHexID(input.DeviceID, 64) || !validHexID(input.PrimaryID, 64) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	counterpart := access.Principal{ProfileID: input.ProfileID, DeviceID: input.DeviceID}
	result, err := access.NewStoreWithClock(p.store.db, p.store.now).PreviewProfileLink(r.Context(),
		p.resolveSession(memberBearer(r)), counterpart, input.PrimaryID,
		func(ctx context.Context, query access.SessionQuery, actor, candidate access.Principal) error {
			if !p.validProfileConsentExpiry(input.ExpiresAt) {
				return access.ErrProfileLinkExpired
			}
			_, key, err := protectedSigner(ctx, query, candidate.DeviceID)
			if err != nil {
				return err
			}
			frame, err := signatureFrame("pawtalk-protected-profile-link-participant-v1", p.serverID, p.cutoverDigest,
				candidate.ProfileID, candidate.DeviceID, strconv.FormatInt(input.ExpiresAt, 10))
			if err != nil || !validProtectedSigningProof(hex.EncodeToString(key), frame, input.Proof) {
				return memberError(http.StatusForbidden, "INVALID_PROFILE_LINK_PROOF")
			}
			for _, profile := range []string{actor.ProfileID, candidate.ProfileID} {
				if _, err := p.store.protectedInviteBoundProfile(ctx, query, profile); err != nil {
					return err
				}
			}
			return nil
		})
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, result)
}

func (p *protectedRuntime) validProfileConsentExpiry(expiry int64) bool {
	now := p.store.now()
	return expiry > now.UnixMilli() && expiry <= now.Add(profileLinkConsentLifetime).UnixMilli()
}

type protectedProfileLinkApplyRequest struct {
	OperationID      string `json:"operationId"`
	PolicyHead       string `json:"policyHead"`
	PrimaryProfile   string `json:"primaryProfileId"`
	PrimaryDevice    string `json:"primaryDeviceId"`
	SecondaryProfile string `json:"secondaryProfileId"`
	SecondaryDevice  string `json:"secondaryDeviceId"`
	ExpiresAt        int64  `json:"expiresAt"`
	PrimaryProof     string `json:"primaryProof"`
	SecondaryProof   string `json:"secondaryProof"`
}

type protectedProfileUnlinkApplyRequest struct {
	OperationID string `json:"operationId"`
	PolicyHead  string `json:"policyHead"`
	Source      string `json:"sourceProfileId"`
	ExpiresAt   int64  `json:"expiresAt"`
	Proof       string `json:"deviceProof"`
}

func (p *protectedRuntime) applyProfileLinkHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedProfileLinkApplyRequest
	if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
		memberFail(w, err)
		return
	}
	p.commitProfileLinkHTTP(w, r, access.PolicyDraft{Action: access.LinkPolicyProfiles, OperationID: input.OperationID,
		PreviousDigest: input.PolicyHead, ResourceChange: &access.PolicyResourceChange{ID: input.PrimaryProfile,
			ProfileLink: &access.ProfilePolicyLink{PrimaryDeviceID: input.PrimaryDevice, SecondaryProfileID: input.SecondaryProfile,
				SecondaryDeviceID: input.SecondaryDevice, ExpiresAt: input.ExpiresAt, PrimaryProof: input.PrimaryProof,
				SecondaryProof: input.SecondaryProof, CutoverDigest: p.cutoverDigest}}})
}

func (p *protectedRuntime) applyProfileUnlinkHTTP(w http.ResponseWriter, r *http.Request) {
	var input protectedProfileUnlinkApplyRequest
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	p.commitProfileLinkHTTP(w, r, access.PolicyDraft{Action: access.UnlinkPolicyProfile, OperationID: input.OperationID,
		PreviousDigest: input.PolicyHead, ResourceChange: &access.PolicyResourceChange{ID: input.Source,
			ProfileUnlink: &access.ProfilePolicyUnlink{ExpiresAt: input.ExpiresAt, DeviceProof: input.Proof,
				CutoverDigest: p.cutoverDigest, GrantDeviceRebind: true}}})
}

func (p *protectedRuntime) commitProfileLinkHTTP(w http.ResponseWriter, r *http.Request, draft access.PolicyDraft) {
	var key []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		memberFail(w, err)
		return
	}
	if draft.Action == access.LinkPolicyProfiles {
		draft.ResourceChange.ProfileLink.ServerKey = b64.EncodeToString(key)
	} else {
		draft.ResourceChange.ProfileUnlink.ServerKey = b64.EncodeToString(key)
	}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitProfileLinking(r.Context(), p.resolveSession(memberBearer(r)),
		draft, p.verifyProfileLinkIntent, signProtectedServerPolicy, verifyProtectedPolicyDraft, syncProfileLinkSessions)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"operationId": proof.Draft.OperationID, "revision": proof.Draft.Revision, "digest": proof.Digest})
}

func (p *protectedRuntime) verifyProfileLinkIntent(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	var expiresAt int64
	if draft.Action == access.LinkPolicyProfiles {
		expiresAt = draft.ResourceChange.ProfileLink.ExpiresAt
	} else {
		expiresAt = draft.ResourceChange.ProfileUnlink.ExpiresAt
	}
	if !p.validProfileConsentExpiry(expiresAt) {
		return access.ErrProfileLinkExpired
	}
	basis, err := access.ReadProfileLinkingBasis(ctx, query, actor, draft)
	if err != nil {
		return err
	}
	if err := verifyProtectedProfileLinkConsent(ctx, query, actor, draft, basis); err != nil {
		return err
	}
	for _, group := range [][]string{basis.PrimaryGroup, basis.SecondaryGroup} {
		for _, profile := range group {
			if _, err := p.store.protectedInviteBoundProfile(ctx, query, profile); err != nil {
				return err
			}
		}
	}
	if draft.Action == access.UnlinkPolicyProfile && actor.ProfileID == basis.Owner {
		reader, ok := query.(access.ScopeAuthorityQuery)
		if !ok {
			return access.ErrScopeAuthority
		}
		head, err := access.ReadPolicyHead(ctx, query, &actor)
		if err != nil {
			return err
		}
		_, authority, err := access.ReadScopeAuthorityProofs(ctx, reader, p.serverID, p.cutoverDigest, head.Draft.Revision)
		if err != nil {
			return err
		}
		if slices.Contains(basis.AffectedDevices, authority.DeviceID) {
			return memberError(http.StatusConflict, "PROTECTED_SCOPE_SIGNER_HANDOVER_REQUIRED")
		}
	}
	return nil
}

func syncProfileLinkSessions(ctx context.Context, tx *sql.Tx, actor access.Principal, draft access.PolicyDraft) error {
	basis, err := access.ReadProfileLinkingBasis(ctx, tx, actor, draft)
	if err != nil {
		return err
	}
	for _, device := range basis.AffectedDevices {
		if _, err := tx.ExecContext(ctx, "DELETE FROM protected_runtime_sessions WHERE device_id=?", device); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM protected_pending_invite_sessions WHERE device_id=?", device); err != nil {
			return err
		}
	}
	return nil
}
