package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type membershipAPI struct {
	store     *membershipStore
	cfg       config
	limiterMu sync.Mutex
	attempts  map[string]attempt
}

func newMembershipHandler(store *membershipStore, cfg config) http.Handler {
	api := &membershipAPI{store: store, cfg: cfg, attempts: make(map[string]attempt)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/config", api.publicConfig)
	mux.HandleFunc("GET /api/v2/challenge", api.challenge)
	mux.HandleFunc("POST /api/v2/session", api.session)
	mux.HandleFunc("GET /api/v2/state", api.state)
	mux.HandleFunc("PATCH /api/v2/server/avatar", api.patchServerAvatar)
	mux.HandleFunc("PATCH /api/v2/server", api.renameServer)
	mux.HandleFunc("POST /api/v2/activity", api.activity)
	mux.HandleFunc("POST /api/v2/heartbeat", api.heartbeat)
	mux.HandleFunc("POST /api/v2/leave", api.leave)
	mux.HandleFunc("PUT /api/v2/members/{id}/role", api.role)
	mux.HandleFunc("GET /api/v2/invites", api.listInvites)
	mux.HandleFunc("POST /api/v2/invites", api.createInvite)
	mux.HandleFunc("DELETE /api/v2/invites/{id}", api.revokeInvite)
	mux.HandleFunc("POST /api/v2/invites/prepare", api.prepareInvite)
	mux.HandleFunc("POST /api/v2/invites/confirm", api.confirmInvite)
	mux.HandleFunc("POST /api/v2/members/{id}/kick", api.kick)
	mux.HandleFunc("POST /api/v2/members/{id}/ban", api.ban)
	mux.HandleFunc("DELETE /api/v2/bans/{id}", api.revokeBan)
	mux.HandleFunc("GET /api/v2/bans", api.listBans)
	mux.HandleFunc("POST /api/v2/links", api.limited(api.startLink))
	mux.HandleFunc("POST /api/v2/links/{id}/propose", api.limited(api.proposeLink))
	mux.HandleFunc("POST /api/v2/links/{id}/approve", api.limited(api.approveLink))
	mux.HandleFunc("POST /api/v2/links/{id}/confirm", api.limited(api.acceptLink))
	mux.HandleFunc("POST /api/v2/links/{id}/cancel", api.limited(api.cancelLink))
	mux.HandleFunc("POST /api/v2/links/{id}/status", api.limited(api.linkStatus))
	mux.HandleFunc("POST /api/v2/control", api.transferControl)
	mux.HandleFunc("POST /api/v2/devices/{id}/unlink", api.limited(api.unlinkDevice))
	mux.HandleFunc("POST /api/v2/devices/{id}/revoke", api.limited(api.revokeDevice))
	mux.HandleFunc("POST /api/v2/channels", api.createChannel)
	mux.HandleFunc("POST /api/v2/channel-order", api.reorderChannels)
	mux.HandleFunc("PATCH /api/v2/channels/{id}", api.patchChannel)
	mux.HandleFunc("DELETE /api/v2/channels/{id}", api.deleteChannel)
	mux.HandleFunc("GET /api/v2/channels/{id}/messages", api.messages)
	mux.HandleFunc("POST /api/v2/channels/{id}/messages", api.postMessage)
	mux.HandleFunc("PATCH /api/v2/messages/{id}", api.editMessage)
	mux.HandleFunc("DELETE /api/v2/messages/{id}", api.deleteMessage)
	mux.HandleFunc("POST /api/v2/channels/{id}/attachments/{attachment}", api.putAttachment)
	mux.HandleFunc("GET /api/v2/channels/{id}/attachments/{attachment}", api.attachment)
	mux.HandleFunc("POST /api/v2/voice/join", api.joinVoice)
	mux.HandleFunc("POST /api/v2/voice/leave", api.leaveVoice)
	mux.HandleFunc("POST /api/v2/voice/heartbeat", api.voiceHeartbeat)
	mux.HandleFunc("PATCH /api/v2/profile", api.patchProfile)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	mux.Handle("GET /api/updates/", newUpdateRelay(cfg.UpdateCacheDir))
	mux.HandleFunc("/api/v2/", func(w http.ResponseWriter, r *http.Request) { memberFail(w, memberError(404, "NOT_FOUND")) })
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { memberFail(w, memberError(426, "UNSUPPORTED_PROTOCOL")) })
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		mux.ServeHTTP(w, r)
	})
}

func memberFail(w http.ResponseWriter, err error) {
	var failure *membershipError
	if !errors.As(err, &failure) {
		failure = &membershipError{Code: "SERVER_ERROR", Status: 500}
	}
	payload := map[string]any{"code": failure.Code, "message": failure.Code}
	if failure.Details != nil {
		payload["details"] = failure.Details
	}
	respond(w, failure.Status, map[string]any{"error": payload})
}

func (a *membershipAPI) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if a.rate(w, r) {
			next(w, r)
		}
	}
}

// No proxy-supplied IP is accepted here. A caller can only consume its observed
// address's bucket; the hosting reverse proxy may inject a trusted context later.
func (a *membershipAPI) rate(w http.ResponseWriter, r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	now := a.store.now()
	a.limiterMu.Lock()
	defer a.limiterMu.Unlock()
	for key, value := range a.attempts {
		if now.Sub(value.start) >= time.Minute {
			delete(a.attempts, key)
		}
	}
	bucket, exists := a.attempts[host]
	if !exists {
		if len(a.attempts) >= 4096 {
			memberFail(w, memberError(429, "RATE_LIMIT"))
			return false
		}
		bucket = attempt{start: now}
	}
	if bucket.count >= 120 {
		w.Header().Set("Retry-After", "60")
		memberFail(w, memberError(429, "RATE_LIMIT"))
		return false
	}
	bucket.count++
	a.attempts[host] = bucket
	return true
}

func decodeMemberJSON(w http.ResponseWriter, r *http.Request, limit int64, target any) ([]byte, error) {
	if strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/json" {
		return nil, memberError(415, "JSON_REQUIRED")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		return nil, memberError(413, "BODY_TOO_LARGE")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, memberError(400, "INVALID_JSON")
	}
	return raw, nil
}

func memberRequestProof(r *http.Request) (membershipProof, error) {
	var result membershipProof
	encoded := r.Header.Get("X-PawTalk-Proof")
	if len(encoded) > 2732 {
		return result, memberError(401, "INVALID_PROOF")
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(raw) > 2048 || len(raw) == 0 {
		return result, memberError(401, "INVALID_PROOF")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF {
		return result, memberError(401, "INVALID_PROOF")
	}
	return result, nil
}

// A public server ID is not a channel binding. Bind signatures to the locally
// configured TLS identity (or configured CA-authenticated origin) to reject relay
// of a victim server's challenges through an attacker-controlled server.
func (a *membershipAPI) transportBinding(r *http.Request) string {
	if a.cfg.AuthBinding != "" {
		return a.cfg.AuthBinding
	}
	// Isolated native test/dev HTTP is the only dynamic-origin mode.
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil || host != "127.0.0.1" || r.TLS != nil {
		return ""
	}
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return ""
	}
	ip := net.ParseIP(remote)
	if ip == nil || !ip.IsLoopback() {
		return ""
	}
	return "origin:http://" + r.Host
}
func (a *membershipAPI) requestProof(r *http.Request) (membershipProof, error) {
	proof, err := memberRequestProof(r)
	if err != nil {
		return proof, err
	}
	expected := a.transportBinding(r)
	if expected == "" || proof.Binding != expected {
		return proof, memberError(401, "SERVER_BINDING_MISMATCH")
	}
	return proof, nil
}

func memberBearer(r *http.Request) string {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return ""
	}
	return token
}

func (a *membershipAPI) publicConfig(w http.ResponseWriter, r *http.Request) {
	var serverID, name string
	var keyID *string
	var revision int64
	var seed, key []byte
	if err := a.store.db.QueryRowContext(r.Context(), "SELECT server_id,name,e2ee_key_id,revision,identity_seed,identity_public_key FROM server_state WHERE id=1").Scan(&serverID, &name, &keyID, &revision, &seed, &key); err != nil {
		memberFail(w, err)
		return
	}
	binding := a.transportBinding(r)
	if binding == "" {
		memberFail(w, memberError(503, "SERVER_BINDING_UNCONFIGURED"))
		return
	}
	initialized := "0"
	if keyID != nil {
		initialized = "1"
	}
	frame, err := signatureFrame("pawtalk-server-v2", serverID, binding, "2", name, initialized, strconv.FormatInt(revision, 10))
	if err != nil {
		memberFail(w, err)
		return
	}
	signature := ed25519.Sign(ed25519.NewKeyFromSeed(seed), frame)
	respond(w, 200, map[string]any{"apiProtocolVersion": membershipProtocol, "capabilities": membershipCapabilities, "e2eeRequired": true, "serverId": serverID, "authBinding": binding, "name": name, "initialized": keyID != nil, "revision": revision, "identityKey": b64.EncodeToString(key), "identitySignature": b64.EncodeToString(signature)})
}

func (a *membershipAPI) challenge(w http.ResponseWriter, r *http.Request) {
	if !a.rate(w, r) {
		return
	}
	result, err := a.store.challenge(r.Context())
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}

func (a *membershipAPI) session(w http.ResponseWriter, r *http.Request) {
	if !a.rate(w, r) {
		return
	}
	var body struct {
		Nickname    string `json:"nickname"`
		DeviceLabel string `json:"deviceLabel"`
	}
	raw, err := decodeMemberJSON(w, r, 4096, &body)
	if err != nil {
		memberFail(w, err)
		return
	}
	proof, err := a.requestProof(r)
	if err != nil {
		memberFail(w, err)
		return
	}
	result, err := a.store.session(r.Context(), proof, r.Method, r.URL.RequestURI(), raw)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}

func (a *membershipAPI) state(w http.ResponseWriter, r *http.Request) {
	result, err := a.store.state(r.Context(), memberBearer(r))
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}

func (a *membershipAPI) heartbeat(w http.ResponseWriter, r *http.Request) {
	var body struct{}
	if _, err := decodeMemberJSON(w, r, 64, &body); err != nil {
		memberFail(w, err)
		return
	}
	result, err := a.store.heartbeat(r.Context(), memberBearer(r))
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}

func (s *membershipStore) heartbeat(ctx context.Context, token string) (memberAccess, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return memberAccess{}, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return access, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE sessions SET last_seen_at=? WHERE session_id=?", s.now().UnixMilli(), access.SessionID); err != nil {
		return access, err
	}
	return access, tx.Commit()
}

func (a *membershipAPI) leave(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &body); err != nil {
		memberFail(w, err)
		return
	}
	targets := a.store.captureOwnGroupMedia(r.Context(), memberBearer(r))
	if err := a.store.leave(r.Context(), memberBearer(r), body.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	a.removeTargets(r.Context(), targets)
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *membershipAPI) role(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Role      string `json:"role"`
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 512, &body); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.changeRole(r.Context(), memberBearer(r), r.PathValue("id"), body.Role, body.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *membershipAPI) prepareInvite(w http.ResponseWriter, r *http.Request) {
	if !a.rate(w, r) {
		return
	}
	var body memberPrepare
	raw, err := decodeMemberJSON(w, r, 8192, &body)
	if err != nil {
		memberFail(w, err)
		return
	}
	proof, err := a.requestProof(r)
	if err != nil {
		memberFail(w, err)
		return
	}
	result, err := a.store.prepareInvite(r.Context(), proof, r.Method, r.URL.RequestURI(), raw, body)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}
func (a *membershipAPI) confirmInvite(w http.ResponseWriter, r *http.Request) {
	if !a.rate(w, r) {
		return
	}
	var body memberConfirm
	raw, err := decodeMemberJSON(w, r, 4096, &body)
	if err != nil {
		memberFail(w, err)
		return
	}
	proof, err := a.requestProof(r)
	if err != nil {
		memberFail(w, err)
		return
	}
	result, err := a.store.confirmInvite(r.Context(), proof, r.Method, r.URL.RequestURI(), raw, body)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, result)
}
func (a *membershipAPI) createInvite(w http.ResponseWriter, r *http.Request) {
	var body memberInviteCreate
	if _, err := decodeMemberJSON(w, r, 8192, &body); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.createInvite(r.Context(), memberBearer(r), body); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 201, map[string]string{"id": body.InviteID})
}
func (a *membershipAPI) listInvites(w http.ResponseWriter, r *http.Request) {
	result, err := a.store.listInvites(r.Context(), memberBearer(r))
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]any{"invites": result})
}
func (a *membershipAPI) revokeInvite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &body); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.revokeInvite(r.Context(), memberBearer(r), r.PathValue("id"), body.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (a *membershipAPI) kick(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &body); err != nil {
		memberFail(w, err)
		return
	}
	targets := a.store.captureGroupMedia(r.Context(), r.PathValue("id"))
	if err := a.store.kick(r.Context(), memberBearer(r), r.PathValue("id"), body.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	a.removeTargets(r.Context(), targets)
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) ban(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestID string `json:"requestId"`
		Expires   *int64 `json:"expiresAt"`
		Reason    string `json:"reason"`
	}
	if _, err := decodeMemberJSON(w, r, 4096, &body); err != nil {
		memberFail(w, err)
		return
	}
	targets := a.store.captureGroupMedia(r.Context(), r.PathValue("id"))
	if err := a.store.ban(r.Context(), memberBearer(r), r.PathValue("id"), body.RequestID, body.Expires, body.Reason); err != nil {
		memberFail(w, err)
		return
	}
	a.removeTargets(r.Context(), targets)
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) revokeBan(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &body); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.revokeBan(r.Context(), memberBearer(r), r.PathValue("id"), body.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) listBans(w http.ResponseWriter, r *http.Request) {
	result, err := a.store.listBans(r.Context(), memberBearer(r))
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]any{"bans": result})
}
