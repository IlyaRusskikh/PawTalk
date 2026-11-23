package main

import (
	"net/http"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) composerActivityHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	var input struct {
		Activity string `json:"activity"`
	}
	if _, err := decodeMemberJSON(w, r, 48, &input); err != nil {
		memberFail(w, err)
		return
	}
	if !validHexID(channel, 32) || (input.Activity != "typing" && input.Activity != "recording" && input.Activity != "idle") {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	err := store.DispatchComposerActivity(r.Context(), p.resolveSession(memberBearer(r)), channel, input.Activity, func(profile string) {
		p.events.publish(memberEvent{Type: "composer", ChannelID: channel, composerProfileID: profile, composerKind: input.Activity})
	})
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}
