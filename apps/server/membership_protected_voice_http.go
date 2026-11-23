package main

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"pawtalk/server/internal/access"
)

// The protected protocol selects this handler after opening its own schema.
// API 2 startup and its route table stay separate.
func newProtectedVoiceHandler(store *membershipStore, cfg config) http.Handler {
	api := &membershipAPI{store: store, cfg: cfg}
	mux := http.NewServeMux()
	registerProtectedVoiceRoutes(mux, api, newProtectedRequestLimiter(store))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
}

func registerProtectedVoiceRoutes(mux *http.ServeMux, api *membershipAPI, limiter *protectedRequestLimiter) {
	mux.HandleFunc("POST /api/v3/voice/join", limiter.limited(api.protectedVoiceJoin))
	mux.HandleFunc("POST /api/v3/voice/heartbeat", limiter.limited(api.protectedVoiceHeartbeat))
	mux.HandleFunc("POST /api/v3/voice/leave", limiter.limited(api.protectedVoiceLeave))
	mux.HandleFunc("POST /api/v3/voice/move", limiter.limited(api.protectedVoiceMove))
	mux.HandleFunc("GET /api/v3/voice/move", limiter.limited(api.protectedVoiceDestination))
	mux.HandleFunc("GET /api/v3/voice/{source}/move-choices/{session}", limiter.limited(api.protectedVoiceMoveChoices))
	mux.HandleFunc("GET /api/v3/voice/{source}/restriction-choices/{session}", limiter.limited(api.protectedVoiceRestrictionChoices))
	mux.HandleFunc("POST /api/v3/voice/{source}/disconnect/{session}", limiter.limited(api.protectedVoiceDisconnect))
	mux.HandleFunc("POST /api/v3/voice/{source}/telemetry", limiter.limited(api.protectedVoiceTelemetry))
	mux.HandleFunc("POST /api/v3/voice/{source}/channel-control/{session}", limiter.limited(api.protectedVoiceChannelControl))
}

func protectedVoiceFail(w http.ResponseWriter, err error) {
	var unavailable mediaResponseError
	switch {
	case errors.Is(err, access.InvalidAction):
		err = memberError(400, "INVALID_ACTION")
	case errors.Is(err, access.ChannelRestricted), errors.Is(err, access.Inactive), errors.Is(err, access.MissingGrant),
		errors.Is(err, access.HierarchyDenied), errors.Is(err, access.TimedOut):
		err = memberError(403, "VOICE_ACCESS_DENIED")
	case errors.Is(err, access.ErrVoiceOccupied):
		err = memberError(409, "VOICE_OCCUPIED")
	case errors.Is(err, access.ErrVoiceFull):
		err = memberError(409, "VOICE_FULL")
	case errors.Is(err, access.ErrVoiceSlotLost):
		err = memberError(409, "VOICE_SLOT_LOST")
	case errors.Is(err, access.ErrVoiceGrantChanged):
		err = memberError(409, "VOICE_GRANT_CHANGED")
	case errors.As(err, &unavailable):
		err = memberError(503, "MEDIA_UNAVAILABLE")
	}
	memberFail(w, err)
}

func (a *membershipAPI) protectedVoiceJoin(w http.ResponseWriter, r *http.Request) {
	var input struct{ ChannelID, KeyEpoch string }
	if _, err := decodeMemberJSON(w, r, 256, &input); err != nil {
		memberFail(w, err)
		return
	}
	cfg := a.cfg
	if local, ok := r.Context().Value(mediaURLKey{}).(string); ok {
		cfg.LivekitURL = local
	}
	grant, err := a.store.joinProtectedVoiceWithKey(r.Context(), memberBearer(r), input.ChannelID, input.KeyEpoch, cfg)
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusOK, grant)
}

func (a *membershipAPI) protectedVoiceHeartbeat(w http.ResponseWriter, r *http.Request) {
	if _, err := decodeMemberJSON(w, r, 64, &struct{}{}); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.heartbeatProtectedVoice(r.Context(), memberBearer(r)); err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *membershipAPI) protectedVoiceLeave(w http.ResponseWriter, r *http.Request) {
	if _, err := decodeMemberJSON(w, r, 64, &struct{}{}); err != nil {
		memberFail(w, err)
		return
	}
	if _, _, err := a.store.leaveProtectedVoice(r.Context(), memberBearer(r)); err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func (a *membershipAPI) protectedVoiceMove(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ProfileID, TargetSessionID, SourceChannelID, DestinationChannelID string
	}
	if _, err := decodeMemberJSON(w, r, 512, &input); err != nil {
		memberFail(w, err)
		return
	}
	if input.TargetSessionID != "" && (input.ProfileID != "" || !validHexID(input.TargetSessionID, 32) || input.DestinationChannelID == "") {
		protectedVoiceFail(w, access.InvalidAction)
		return
	}
	if err := a.store.planProtectedVoiceMoveTarget(r.Context(), a.cfg, memberBearer(r), input.ProfileID,
		input.TargetSessionID, input.SourceChannelID, input.DestinationChannelID); err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusAccepted, map[string]bool{"pending": true})
}

func (a *membershipAPI) protectedVoiceMoveChoices(w http.ResponseWriter, r *http.Request) {
	source, targetSession := r.PathValue("source"), r.PathValue("session")
	if !validHexID(source, 32) || !validHexID(targetSession, 32) {
		protectedVoiceFail(w, access.InvalidAction)
		return
	}
	destinations, err := a.store.protectedVoiceMoveChoices(r.Context(), memberBearer(r), source, targetSession)
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string][]string{"destinations": destinations})
}

func (a *membershipAPI) protectedVoiceRestrictionChoices(w http.ResponseWriter, r *http.Request) {
	source, targetSession := r.PathValue("source"), r.PathValue("session")
	if !validHexID(source, 32) || !validHexID(targetSession, 32) {
		protectedVoiceFail(w, access.InvalidAction)
		return
	}
	choices, err := a.store.protectedVoiceRestrictionChoices(r.Context(), memberBearer(r), source, targetSession)
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	if r.URL.Query().Get("serverWide") != "1" {
		choices.Actions = slices.DeleteFunc(choices.Actions, func(choice access.VoiceRestrictionChoice) bool { return choice.ServerWide })
		if len(choices.Actions) == 0 {
			choices.ProfileID = ""
		}
	}
	respond(w, http.StatusOK, choices)
}

func (a *membershipAPI) protectedVoiceDisconnect(w http.ResponseWriter, r *http.Request) {
	source, session := r.PathValue("source"), r.PathValue("session")
	if !validHexID(source, 32) || !validHexID(session, 32) {
		protectedVoiceFail(w, access.InvalidAction)
		return
	}
	if err := a.store.disconnectProtectedVoice(r.Context(), a.cfg, memberBearer(r), source, session); err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"disconnected": true})
}

func (a *membershipAPI) protectedVoiceDestination(w http.ResponseWriter, r *http.Request) {
	destination, err := a.store.readyProtectedVoiceMove(r.Context(), memberBearer(r))
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]string{"channelId": destination})
}

// The protected host owns this worker's lifetime. A failed attempt stays
// pending and the next pass rechecks the then-current policy before applying it.
func (s *membershipStore) runProtectedVoiceControl(ctx context.Context, cfg config, interval time.Duration, onError func(error)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		if err := s.reconcilePendingProtectedVoice(ctx, cfg); err != nil && ctx.Err() == nil && onError != nil {
			onError(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
