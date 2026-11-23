package main

import (
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) ownProfileAvatarHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchOwnProfileAvatar(r.Context(),
		p.resolveSession(memberBearer(r)), r.URL.Query().Get("shared"), func(view access.ProfileAvatarView) error {
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, view)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) profileAvatarAudienceHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchProfileAvatarAudience(r.Context(),
		p.resolveSession(memberBearer(r)), r.URL.Query().Get("after"), r.URL.Query().Get("shared"), func(page access.CommunityAvatarAudience) error {
			w.Header().Set("Cache-Control", "no-store")
			return writeProtectedDelivery(w, &sent, page)
		})
	if err != nil && !sent {
		protectedPolicyFail(w, err)
	}
}

func (p *protectedRuntime) saveOwnProfileAvatarHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.CommunityAvatarUpdate
	if _, err := decodeMemberJSON(w, r, 1536<<10, &input); err != nil {
		memberFail(w, err)
		return
	}
	revision, err := access.NewStoreWithClock(p.store.db, p.store.now).SaveOwnProfileAvatar(r.Context(),
		p.resolveSession(memberBearer(r)), input, r.URL.Query().Get("shared"))
	if errors.Is(err, access.ErrCommunityAvatarChanged) || errors.Is(err, access.ErrEpochRecipients) {
		err = memberError(http.StatusConflict, "PROFILE_AVATAR_CHANGED")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	p.events.publish(memberEvent{Type: "state", protectedProfileID: input.Context.ProfileID})
	respond(w, http.StatusOK, map[string]int64{"revision": revision})
}
