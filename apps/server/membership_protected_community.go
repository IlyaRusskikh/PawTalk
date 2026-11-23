package main

import (
	"errors"
	"net/http"
	"strings"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) renameCommunityHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.CommunityName
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if !validMemberLabel(input.Name) || input.Revision < 1 || input.Revision >= migrationMaxSafePosition {
		memberFail(w, memberError(http.StatusBadRequest, "INVALID_SERVER_NAME"))
		return
	}
	result, err := access.NewStoreWithClock(p.store.db, p.store.now).RenameCommunity(r.Context(), p.resolveSession(memberBearer(r)), input)
	if errors.Is(err, access.ErrCommunityChanged) {
		err = memberError(http.StatusConflict, "SERVER_NAME_CHANGED")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, result)
}

func (p *protectedRuntime) readCommunityAvatarHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchCommunityAvatar(r.Context(),
		p.resolveSession(memberBearer(r)), func(view access.CommunityAvatarView) error {
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, view)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) saveCommunityAvatarHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.CommunityAvatarUpdate
	if _, err := decodeMemberJSON(w, r, 1536<<10, &input); err != nil {
		memberFail(w, err)
		return
	}
	revision, err := access.NewStoreWithClock(p.store.db, p.store.now).SaveCommunityAvatar(r.Context(), p.resolveSession(memberBearer(r)), input)
	if errors.Is(err, access.ErrCommunityAvatarChanged) || errors.Is(err, access.ErrEpochRecipients) {
		err = memberError(http.StatusConflict, "SERVER_AVATAR_CHANGED")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]int64{"revision": revision})
}

func (p *protectedRuntime) communityAvatarAudienceHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchCommunityAvatarAudience(r.Context(),
		p.resolveSession(memberBearer(r)), r.URL.Query().Get("after"), func(page access.CommunityAvatarAudience) error {
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, page)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) pendingCommunityAvatarHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchCommunityAvatarPending(r.Context(),
		p.resolveSession(memberBearer(r)), func(result access.CommunityAvatarPendingDelivery) error {
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, result)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) deliverCommunityAvatarHTTP(w http.ResponseWriter, r *http.Request) {
	p.writeCommunityAvatarDelivery(w, r, false)
}

func (p *protectedRuntime) recoverCommunityAvatarHTTP(w http.ResponseWriter, r *http.Request) {
	p.writeCommunityAvatarDelivery(w, r, true)
}

func (p *protectedRuntime) readCommunityAvatarRecoveryHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchCommunityAvatarRecovery(r.Context(),
		p.resolveSession(memberBearer(r)), func(view access.CommunityAvatarView, policyHead string) error {
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, struct {
				access.CommunityAvatarView
				PolicyHead string `json:"policyHead"`
			}{CommunityAvatarView: view, PolicyHead: policyHead})
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) writeCommunityAvatarDelivery(w http.ResponseWriter, r *http.Request, recoverOwn bool) {
	var input access.CommunityAvatarDelivery
	if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
		memberFail(w, err)
		return
	}
	err := access.NewStoreWithClock(p.store.db, p.store.now).DeliverCommunityAvatar(r.Context(), p.resolveSession(memberBearer(r)), input, recoverOwn)
	if errors.Is(err, access.ErrCommunityAvatarChanged) {
		err = memberError(http.StatusConflict, "SERVER_AVATAR_CHANGED")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) readLegacyCommunityAvatarHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchLegacyCommunityAvatar(r.Context(),
		p.resolveSession(memberBearer(r)), func(avatar access.LegacyCommunityAvatar) error {
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, avatar)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}
