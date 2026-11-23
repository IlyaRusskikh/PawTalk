package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"pawtalk/server/internal/access"
)

var errInvalidMediaGrant = errors.New("invalid media grant")

type mediaGrantClaims struct {
	Issuer     string            `json:"iss"`
	Subject    string            `json:"sub"`
	Expires    int64             `json:"exp"`
	NotBefore  int64             `json:"nbf"`
	Attributes map[string]string `json:"attributes"`
	Video      struct {
		Room           string `json:"room"`
		Join           bool   `json:"roomJoin"`
		CanPublish     *bool  `json:"canPublish"`
		CanSubscribe   *bool  `json:"canSubscribe"`
		CanPublishData *bool  `json:"canPublishData"`
	}
}

func verifyMediaGrant(cfg config, token string, now time.Time) (mediaGrantClaims, error) {
	var claims mediaGrantClaims
	header, rest, ok := strings.Cut(token, ".")
	body, signature, found := strings.Cut(rest, ".")
	if !ok || !found || len(token) > 8192 || cfg.APISecret == "" {
		return claims, errInvalidMediaGrant
	}
	decodedSignature, err := b64.DecodeString(signature)
	if err != nil {
		return claims, errInvalidMediaGrant
	}
	mac := hmac.New(sha256.New, []byte(cfg.APISecret))
	mac.Write([]byte(header + "." + body))
	if !hmac.Equal(mac.Sum(nil), decodedSignature) {
		return claims, errInvalidMediaGrant
	}
	raw, err := b64.DecodeString(header)
	var format struct{ Alg string }
	if err != nil || json.Unmarshal(raw, &format) != nil || format.Alg != "HS256" {
		return claims, errInvalidMediaGrant
	}
	payload, err := b64.DecodeString(body)
	if err != nil || json.Unmarshal(payload, &claims) != nil || claims.Issuer != cfg.APIKey ||
		claims.Subject == "" || claims.Expires <= now.Unix() || claims.NotBefore > now.Unix() ||
		!claims.Video.Join || claims.Video.Room == "" {
		return mediaGrantClaims{}, errInvalidMediaGrant
	}
	return claims, nil
}

func mediaSignalToken(r *http.Request) (string, error) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query["access_token"]) > 1 || len(r.Header.Values("Authorization")) > 1 {
		return "", errInvalidMediaGrant
	}
	token := query.Get("access_token")
	if header := r.Header.Get("Authorization"); header != "" {
		scheme, bearer, ok := strings.Cut(header, " ")
		if !ok || !strings.EqualFold(scheme, "Bearer") || bearer == "" || (token != "" && token != bearer) {
			return "", errInvalidMediaGrant
		}
		token = bearer
	}
	return token, nil
}

func (s *membershipStore) authorizeProtectedSignal(ctx context.Context, claims mediaGrantClaims, token string) error {
	if !validHexID(claims.Subject, 32) || claims.Video.CanPublish == nil || claims.Video.CanSubscribe == nil {
		return errInvalidMediaGrant
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	channel, ok := strings.CutPrefix(claims.Video.Room, protectedVoiceRoom(serverID, ""))
	if !ok || !validHexID(channel, 32) {
		return errInvalidMediaGrant
	}
	now := s.now()
	actor, err := s.protectedSignalPrincipal(ctx, tx, claims.Subject, now.UnixMilli())
	if err != nil {
		return err
	}
	if s.protectedBinding != "" {
		epoch := claims.Attributes["pawtalk.voice-epoch"]
		if claims.Attributes["pawtalk.voice-parked"] == "true" {
			if epoch != "" || *claims.Video.CanPublish || *claims.Video.CanSubscribe ||
				claims.Video.CanPublishData == nil || *claims.Video.CanPublishData {
				return errInvalidMediaGrant
			}
		} else {
			deadline, err := s.validateVoiceKeyGrant(ctx, tx, serverID, channel, claims.Subject, epoch, actor, now)
			if err != nil {
				return err
			}
			if claims.Expires > deadline.Unix() {
				return errInvalidMediaGrant
			}
		}
	}
	return access.ValidateVoiceSignal(ctx, tx, actor, channel, claims.Subject, publicKeyID([]byte(token)),
		*claims.Video.CanPublish, *claims.Video.CanSubscribe, now.UnixMilli())
}

func (s *membershipStore) protectedSignalPrincipal(ctx context.Context, query access.SessionQuery, sessionID string, now int64) (access.Principal, error) {
	if s.protectedBinding != "" {
		return s.runtimeIdentityForSession(ctx, query, sessionID)
	}
	var identity memberIdentity
	err := query.QueryRowContext(ctx, `SELECT d.device_id,d.original_profile_id FROM sessions s JOIN devices d ON d.device_id=s.device_id
		WHERE s.session_id=? AND s.revoked_at IS NULL AND s.expires_at>?`, sessionID, now).
		Scan(&identity.DeviceID, &identity.ProfileID)
	if err != nil {
		return access.Principal{}, err
	}
	member, err := s.resolveIdentity(ctx, query, identity)
	if err != nil {
		return access.Principal{}, err
	}
	return verifiedProtectedPrincipal(ctx, query, member, true)
}

func membershipMediaHandler(store *membershipStore, cfg config, target *url.URL) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(target)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, ok := strings.CutPrefix(r.URL.Path, "/rtc")
		if !ok {
			http.NotFound(w, r)
			return
		}
		switch path {
		case "", "/":
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				http.NotFound(w, r)
				return
			}
			path = "/"
		case "/rtc", "/rtc/validate", "/rtc/v1", "/rtc/v1/validate":
			deny := func(message string, status int) {
				if strings.HasSuffix(path, "/validate") {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				}
				http.Error(w, message, status)
			}
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if r.Method != http.MethodGet && r.Method != http.MethodPost {
				http.NotFound(w, r)
				return
			}
			token, err := mediaSignalToken(r)
			if err != nil {
				deny("invalid media grant", http.StatusUnauthorized)
				return
			}
			claims, err := verifyMediaGrant(cfg, token, store.now())
			if err != nil {
				deny("invalid media grant", http.StatusUnauthorized)
				return
			}
			if strings.HasPrefix(claims.Video.Room, "ptp-") {
				// The room's slot applies to the token identity itself.
				if r.Method != http.MethodGet || r.URL.Query().Has("publish") {
					deny("media access denied", http.StatusForbidden)
					return
				}
				if err := store.authorizeProtectedSignal(r.Context(), claims, token); err != nil {
					deny("media access denied", http.StatusForbidden)
					return
				}
			} else if store.protectedBinding != "" {
				deny("media access denied", http.StatusForbidden)
				return
			}
		default:
			http.NotFound(w, r)
			return
		}
		upstream := r.Clone(r.Context())
		upstream.URL.Path, upstream.URL.RawPath = path, ""
		proxy.ServeHTTP(w, upstream)
	})
}
