package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type memberVoice struct {
	URL          string `json:"url"`
	Token        string `json:"token"`
	ChannelID    string `json:"channelId"`
	Identity     string `json:"identity"`
	Room         string `json:"room"`
	ExpiresAt    int64  `json:"expiresAt"`
	E2EERequired bool   `json:"e2eeRequired"`
}

func signedMediaClaims(cfg config, claims map[string]any) (string, error) {
	encoded, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	unsigned := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + b64.EncodeToString(encoded)
	mac := hmac.New(sha256.New, []byte(cfg.APISecret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + b64.EncodeToString(mac.Sum(nil)), nil
}

func (s *membershipStore) joinVoice(ctx context.Context, token, channel string, cfg config) (memberVoice, error) {
	var result memberVoice
	if !validHexID(channel, 32) {
		return result, memberError(400, "INVALID_CHANNEL")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return result, err
	}
	if !access.allows("voice.join") {
		return result, memberError(403, "FORBIDDEN")
	}
	var kind string
	err = tx.QueryRowContext(ctx, "SELECT kind FROM channels WHERE channel_id=?", channel).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return result, memberError(404, "CHANNEL_NOT_FOUND")
	}
	if err != nil {
		return result, err
	}
	if kind != "voice" {
		return result, memberError(400, "VOICE_CHANNEL_REQUIRED")
	}
	now := s.now().UnixMilli()
	if _, err = tx.ExecContext(ctx, "DELETE FROM voice_slots WHERE expires_at<=?", now); err != nil {
		return result, err
	}
	var owner string
	err = tx.QueryRowContext(ctx, "SELECT session_id FROM voice_slots WHERE profile_id=?", access.EffectiveProfileID).Scan(&owner)
	if err == nil && owner != access.SessionID {
		return result, memberError(409, "VOICE_OCCUPIED")
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	var serverID, name string
	if err = tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return result, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT nickname FROM effective_profiles WHERE profile_id=?", access.EffectiveProfileID).Scan(&name); err != nil {
		return result, err
	}
	room := "pt-" + serverID + "-" + channel
	claims := map[string]any{"iss": cfg.APIKey, "sub": access.SessionID, "name": name, "nbf": s.now().Unix() - 5, "exp": s.now().Unix() + 60,
		"video":      map[string]any{"roomJoin": true, "room": room, "canPublish": true, "canSubscribe": true, "canPublishData": true, "canPublishSources": []string{"microphone"}, "canUpdateOwnMetadata": false},
		"attributes": map[string]string{"pawtalk.e2ee": "required", "pawtalk.profile": access.ProfileID, "pawtalk.device": access.DeviceID}}
	mediaToken, err := signedMediaClaims(cfg, claims)
	if err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO voice_slots(profile_id,session_id,channel_id,expires_at) VALUES(?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET channel_id=excluded.channel_id,session_id=excluded.session_id,expires_at=excluded.expires_at", access.EffectiveProfileID, access.SessionID, channel, now+45000); err != nil {
		return result, err
	}
	result = memberVoice{URL: cfg.LivekitURL, Token: mediaToken, ChannelID: channel, Identity: access.SessionID, Room: room, ExpiresAt: now + 45000, E2EERequired: true}
	return result, tx.Commit()
}

func (s *membershipStore) voiceHeartbeat(ctx context.Context, token string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, "UPDATE voice_slots SET expires_at=? WHERE profile_id=? AND session_id=? AND expires_at>?", s.now().UnixMilli()+45000, access.EffectiveProfileID, access.SessionID, s.now().UnixMilli())
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return memberError(409, "VOICE_SLOT_LOST")
	}
	return tx.Commit()
}

func (s *membershipStore) leaveVoice(ctx context.Context, token string) (string, string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return "", "", err
	}
	var serverID, channel string
	if err = tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return "", "", err
	}
	err = tx.QueryRowContext(ctx, "SELECT channel_id FROM voice_slots WHERE session_id=?", access.SessionID).Scan(&channel)
	if errors.Is(err, sql.ErrNoRows) {
		return "", access.SessionID, tx.Commit()
	}
	if err != nil {
		return "", "", err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM voice_slots WHERE session_id=?", access.SessionID); err != nil {
		return "", "", err
	}
	return "pt-" + serverID + "-" + channel, access.SessionID, tx.Commit()
}

// Best-effort removal does not imply self-hosted LiveKit token revocation.
func (a *membershipAPI) removeMedia(ctx context.Context, room, identity string) {
	if room == "" || identity == "" {
		return
	}
	a.mediaRPC(ctx, room, "RemoveParticipant", map[string]string{"room": room, "identity": identity})
}
func (a *membershipAPI) mediaRPC(ctx context.Context, room, method string, body map[string]string) {
	if room == "" || a.cfg.PresenceURL == "" {
		return
	}
	claims := map[string]any{"iss": a.cfg.APIKey, "sub": "pawtalk-control", "nbf": a.store.now().Unix() - 5, "exp": a.store.now().Unix() + 30, "video": map[string]any{"roomAdmin": true, "room": room}}
	token, err := signedMediaClaims(a.cfg, claims)
	if err != nil {
		return
	}
	payload, _ := json.Marshal(body)
	request, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(a.cfg.PresenceURL, "/")+"/twirp/livekit.RoomService/"+method, bytes.NewReader(payload))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 3_000_000_000, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("media redirect forbidden") }}
	response, err := client.Do(request)
	if err == nil {
		response.Body.Close()
	}
}
