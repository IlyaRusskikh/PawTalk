package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) readTimeoutHTTP(w http.ResponseWriter, r *http.Request) {
	profile := r.PathValue("profile")
	if !validHexID(profile, 64) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchTimeout(r.Context(), p.resolveSession(memberBearer(r)),
		profile, func(status access.TimeoutStatus) error { return writeProtectedDelivery(w, &sent, status) })
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) changeTimeoutHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.TimeoutRequest
	if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
		memberFail(w, err)
		return
	}
	receipt, err := access.NewStoreWithClock(p.store.db, p.store.now).ChangeTimeout(r.Context(), p.resolveSession(memberBearer(r)),
		r.PathValue("profile"), input, invalidateTimedOutVoiceKeys)
	if errors.Is(err, access.ErrTimeoutConflict) {
		err = memberError(http.StatusConflict, "PROTECTED_TIMEOUT_CONFLICT")
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, receipt)
}

func invalidateTimedOutVoiceKeys(ctx context.Context, tx *sql.Tx, profile string) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM protected_voice_keys WHERE channel_id IN
		(SELECT channel_id FROM protected_voice_slots WHERE profile_id=? AND active_until>0)`, profile)
	return err
}
