package main

import (
	"context"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

func verifyProtectedProfileLinking(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	basis, err := access.ReadProfileLinkingBasis(ctx, query, actor, draft)
	if err != nil {
		return err
	}
	return verifyProtectedProfileLinkConsent(ctx, query, actor, draft, basis)
}

func verifyProtectedProfileLinkConsent(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft, basis access.ProfileLinkingBasis) error {
	var serverID string
	if err := query.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	invalid := memberError(http.StatusForbidden, "INVALID_PROFILE_LINK_PROOF")
	change := draft.ResourceChange
	if draft.Action == access.LinkPolicyProfiles {
		link := change.ProfileLink
		frame, err := signatureFrame("pawtalk-protected-profile-link-consent-v1", serverID, link.CutoverDigest,
			draft.PreviousDigest, draft.OperationID, actor.ProfileID, link.PrimaryDeviceID,
			link.SecondaryProfileID, link.SecondaryDeviceID, strconv.FormatInt(link.ExpiresAt, 10))
		if err != nil || !validProtectedSigningProof(basis.PrimaryDevice.PublicKey, frame, link.PrimaryProof) ||
			!validProtectedSigningProof(basis.SecondaryDevice.PublicKey, frame, link.SecondaryProof) {
			return invalid
		}
		return nil
	}
	unlink := change.ProfileUnlink
	frame, err := signatureFrame("pawtalk-protected-profile-unlink-consent-v1", serverID, unlink.CutoverDigest,
		draft.PreviousDigest, draft.OperationID, actor.ProfileID, actor.DeviceID, change.ID, strconv.FormatInt(unlink.ExpiresAt, 10))
	if err != nil || !validProtectedSigningProof(basis.PrimaryDevice.PublicKey, frame, unlink.DeviceProof) {
		return invalid
	}
	return nil
}
