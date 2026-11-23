package main

import (
	"net/http"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) protectionWindowHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchProtectionWindow(r.Context(),
		p.resolveSession(memberBearer(r)), channel, verifyProtectedPolicyDraftSignature, verifyProtectedEpochSignature,
		func(window access.ProtectionWindow) error {
			return writeProtectedDelivery(w, &sent, window)
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}
