package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

type protectedDepartureIntent struct {
	ProfileID   string `json:"profileId"`
	DeviceID    string `json:"deviceId"`
	OperationID string `json:"operationId"`
	PolicyHead  string `json:"policyHead"`
	Signature   string `json:"signature"`
	Target      string `json:"target,omitempty"`
	Reason      string `json:"reason,omitempty"`
	ExpiresAt   int64  `json:"expiresAt,omitempty"`
}

func verifyProtectedDepartureIntent(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	if draft.ResourceChange == nil || !validHexID(draft.ResourceChange.ID, 64) || draft.ResourceChange.Departure == nil ||
		!validHexID(actor.ProfileID, 64) || !validHexID(actor.DeviceID, 64) {
		return access.InvalidAction
	}
	departure := draft.ResourceChange.Departure
	serverID, key, err := protectedSigner(ctx, query, actor.DeviceID)
	if err != nil {
		return memberError(http.StatusForbidden, "INVALID_PROTECTED_DEPARTURE_PROOF")
	}
	var frame []byte
	if draft.Action == access.LeavePolicyMember {
		frame, err = signatureFrame("pawtalk-protected-member-departure-v1", serverID, departure.CutoverDigest,
			actor.ProfileID, actor.DeviceID, draft.OperationID, draft.PreviousDigest)
	} else {
		frame, err = signatureFrame("pawtalk-protected-member-moderation-v1", serverID, departure.CutoverDigest,
			actor.ProfileID, actor.DeviceID, draft.OperationID, draft.PreviousDigest, draft.Action,
			draft.ResourceChange.ID, departure.Reason, strconv.FormatInt(departure.ExpiresAt, 10))
	}
	signature, sigErr := decodeFixed(departure.DeviceSignature, ed25519.SignatureSize)
	if err != nil || sigErr != nil || !ed25519.Verify(key, frame, signature) {
		return memberError(http.StatusForbidden, "INVALID_PROTECTED_DEPARTURE_PROOF")
	}
	return nil
}

func (p *protectedRuntime) departureHeadHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	defer tx.Rollback()
	actor, err := p.resolveSession(memberBearer(r))(ctx, tx)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	head, err := access.ReadPolicyHead(ctx, tx, &actor)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]string{"policyHead": head.Digest})
}

func (p *protectedRuntime) departMemberHTTP(w http.ResponseWriter, r *http.Request) {
	p.changeMemberMembershipHTTP(w, r, access.LeavePolicyMember)
}

func (p *protectedRuntime) moderateMembershipHTTP(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	switch action {
	case "kick", "ban", "unban":
		p.changeMemberMembershipHTTP(w, r, "member."+action)
	default:
		protectedRuntimeFail(w, access.InvalidAction)
	}
}

func (p *protectedRuntime) listMemberBansHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchMemberBans(r.Context(), p.resolveSession(memberBearer(r)),
		listInheritedBans, r.URL.Query().Get("after"), func(page access.MemberBanPage) error { return writeProtectedDelivery(w, &sent, page) })
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) changeMemberMembershipHTTP(w http.ResponseWriter, r *http.Request, action string) {
	var input protectedDepartureIntent
	if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
		memberFail(w, err)
		return
	}
	var resolve access.ResolveSession
	if action == access.LeavePolicyMember {
		if input.Target != "" || input.Reason != "" || input.ExpiresAt != 0 {
			protectedRuntimeFail(w, access.InvalidAction)
			return
		}
		input.Target = input.ProfileID
	} else {
		resolve = p.resolveSession(memberBearer(r))
	}
	var key []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	intent := access.PolicyDraft{Action: action, OperationID: input.OperationID, PreviousDigest: input.PolicyHead,
		ResourceChange: &access.PolicyResourceChange{ID: input.Target, Departure: &access.MemberPolicyDeparture{
			CutoverDigest: p.cutoverDigest, DeviceSignature: input.Signature, ServerKey: b64.EncodeToString(key),
			Reason: input.Reason, ExpiresAt: input.ExpiresAt,
		}}}
	actor := access.Principal{ProfileID: input.ProfileID, DeviceID: input.DeviceID}
	_, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitMemberDeparture(r.Context(), actor, intent,
		resolve, hasInheritedBan, verifyProtectedDepartureIntent, signProtectedServerPolicy, verifyProtectedPolicyDraft)
	if errors.Is(err, access.ErrOwnerDeparture) {
		memberFail(w, memberError(http.StatusConflict, "PROTECTED_OWNER_LEAVE"))
		return
	}
	if errors.Is(err, access.ErrPolicyConflict) {
		memberFail(w, memberError(http.StatusConflict, "PROTECTED_DEPARTURE_CHANGED"))
		return
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]string{"operationId": input.OperationID})
}
