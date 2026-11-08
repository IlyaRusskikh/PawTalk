package main

import (
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const roomName = "common"

var b64 = base64.RawURLEncoding

type config struct {
	PresenceURL                                         string
	APIKey, APISecret, LivekitURL, PasswordHash, Listen string
	RequireE2EE                                         bool
	E2EEKeyID                                           string
}
type attempt struct {
	count int
	start time.Time
}
type app struct {
	cfg            config
	chat           *chatStore
	mu             sync.Mutex
	attempts       map[string]attempt
	usedChallenges map[string]int64
	hashSlots      chan struct{}
	now            func() time.Time
}

func parseHash(encoded string) ([]byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" || parts[1] != "600000" {
		return nil, nil, errors.New("expected pbkdf2-sha256$600000$salt$digest")
	}
	salt, e := b64.DecodeString(parts[2])
	if e != nil || len(salt) != 16 {
		return nil, nil, errors.New("invalid password salt")
	}
	digest, e := b64.DecodeString(parts[3])
	if e != nil || len(digest) != 32 {
		return nil, nil, errors.New("invalid password digest")
	}
	return salt, digest, nil
}
func verifyPassword(encoded, password string) bool {
	salt, want, e := parseHash(encoded)
	if e != nil {
		return false
	}
	got, e := pbkdf2.Key(sha256.New, password, salt, 600000, 32)
	return e == nil && subtle.ConstantTimeCompare(got, want) == 1
}
func (a *app) allow(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	for key, v := range a.attempts {
		if now.Sub(v.start) >= time.Minute {
			delete(a.attempts, key)
		}
	}
	v, exists := a.attempts[ip]
	if !exists {
		if len(a.attempts) >= 4096 {
			return false
		}
		v = attempt{start: now}
	}
	if v.count >= 5 {
		return false
	}
	v.count++
	a.attempts[ip] = v
	return true
}
func (a *app) token(identity, nickname string, profileIDs ...string) (string, error) {
	now := a.now().Unix()
	claims := map[string]any{
		"iss": a.cfg.APIKey, "sub": identity, "name": nickname, "nbf": now - 5, "exp": now + 300,
		"video": map[string]any{"roomJoin": true, "room": roomName, "canPublish": true, "canSubscribe": true, "canPublishData": true, "canPublishSources": []string{"microphone"}, "canUpdateOwnMetadata": false},
	}
	if a.cfg.RequireE2EE {
		claims["attributes"] = map[string]string{"voicecord.e2ee": "required"}
	}
	if len(profileIDs) > 0 && profileIDs[0] != "" {
		attributes, _ := claims["attributes"].(map[string]string)
		if attributes == nil {
			attributes = map[string]string{}
		}
		attributes["voicecord.profile"] = profileIDs[0]
		claims["attributes"] = attributes
	}
	payload, e := json.Marshal(claims)
	if e != nil {
		return "", e
	}
	header := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	unsigned := header + "." + b64.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(a.cfg.APISecret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + b64.EncodeToString(mac.Sum(nil)), nil
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func fail(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}
func (a *app) connect(w http.ResponseWriter, r *http.Request) {
	ip, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		ip = r.RemoteAddr
	}
	// Only Caddy's loopback connection may supply the canonical client IP.
	if parsed := net.ParseIP(ip); parsed != nil && parsed.IsLoopback() {
		if forwarded := r.Header.Get("X-Real-IP"); net.ParseIP(forwarded) != nil {
			ip = forwarded
		}
	}
	if !a.allow(ip) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "Слишком много попыток. Подождите минуту.")
		return
	}
	if ct := strings.Split(r.Header.Get("Content-Type"), ";")[0]; ct != "application/json" {
		fail(w, 415, "Ожидается JSON")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var body struct {
		Nickname  string        `json:"nickname"`
		Password  string        `json:"password"`
		E2EE      bool          `json:"e2ee"`
		E2EEKeyID string        `json:"e2eeKeyId"`
		Profile   *profileProof `json:"profile"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		fail(w, 400, "Неверный формат запроса")
		return
	}
	if a.cfg.RequireE2EE && (!body.E2EE || len(body.E2EEKeyID) != 64) {
		fail(w, 426, "В комнате обязательно E2EE. Нужны обновлённый клиент и ключ из приглашения.")
		return
	}
	if a.cfg.RequireE2EE && a.cfg.E2EEKeyID != "" && !hmac.Equal([]byte(body.E2EEKeyID), []byte(a.cfg.E2EEKeyID)) {
		fail(w, 403, "Ключ E2EE не соответствует комнате. Получите актуальное приглашение.")
		return
	}
	rawName := body.Nickname
	body.Nickname = strings.TrimSpace(rawName)
	if !validNickname(body.Nickname) || len(body.Password) > 1024 {
		fail(w, 400, "Никнейм должен содержать от 1 до 32 символов без управляющих знаков")
		return
	}
	select {
	case a.hashSlots <- struct{}{}:
		defer func() { <-a.hashSlots }()
	default:
		fail(w, 503, "Сервер занят. Повторите подключение.")
		return
	}
	if !verifyPassword(a.cfg.PasswordHash, body.Password) {
		fail(w, 401, "Неверный пароль сервера")
		return
	}
	var profileID string
	if body.Profile != nil && a.chat != nil {
		var ok bool
		profileID, ok = a.verifyProfile(*body.Profile, rawName)
		if !ok {
			fail(w, 403, "Invalid profile proof")
			return
		}
	}
	identity := make([]byte, 16)
	if _, e = rand.Read(identity); e != nil {
		fail(w, 500, "Ошибка создания сессии")
		return
	}
	id := b64.EncodeToString(identity)
	token, e := a.token(id, body.Nickname, profileID)
	if e != nil {
		fail(w, 500, "Ошибка создания сессии")
		return
	}
	mediaURL := a.cfg.LivekitURL
	if local, ok := r.Context().Value(mediaURLKey{}).(string); ok {
		mediaURL = local
	}
	result := map[string]any{"url": mediaURL, "token": token, "identity": id, "room": roomName, "expiresIn": 300, "e2eeRequired": a.cfg.RequireE2EE}
	if a.chat != nil {
		result["chatFeed"] = a.chat.feed
		result["chatToken"] = a.chatToken(body.Nickname, profileID)
		result["chatEphemeral"] = a.chat.ephemeral
		result["chatProtocol"] = 2
		if profileID != "" {
			result["profileId"] = profileID
		}
	}
	respond(w, 200, result)
}
func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/updates/", newUpdateRelay())
	presence := a.presenceHandler()
	mux.HandleFunc("GET /api/presence", presence)
	if a.chat != nil {
		mux.HandleFunc("GET /api/preview", presence)
	}
	mux.HandleFunc("POST /api/connect", a.connect)
	if a.chat != nil {
		mux.HandleFunc("GET /api/chat", a.chatHistory)
		mux.HandleFunc("POST /api/chat", a.chatPost)
		mux.HandleFunc("POST /api/chat/profile", a.chatProfile)
		mux.HandleFunc("GET /api/chat/attachments/{id}", a.chatAttachment)
		mux.HandleFunc("POST /api/chat/attachments/{id}", a.chatAttachment)
	}
	mux.HandleFunc("GET /api/config", a.roomConfig)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]string{"status": "ok"}) })
	return mux
}
func loadConfig() (config, error) {
	c := config{APIKey: os.Getenv("LIVEKIT_API_KEY"), APISecret: os.Getenv("LIVEKIT_API_SECRET"), LivekitURL: os.Getenv("LIVEKIT_URL"), PasswordHash: os.Getenv("VOICECORD_PASSWORD_HASH"), Listen: os.Getenv("LISTEN_ADDR")}
	var policyErr error
	c.RequireE2EE, c.E2EEKeyID, policyErr = encryptionPolicy()
	if policyErr != nil {
		return c, policyErr
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8080"
	}
	if c.APIKey == "" || len(c.APISecret) < 32 {
		return c, errors.New("LiveKit key and secret (at least 32 characters) are required")
	}
	if _, _, e := parseHash(c.PasswordHash); e != nil {
		return c, e
	}
	u, e := url.Parse(c.LivekitURL)
	if e != nil || u.Host == "" || (u.Scheme != "wss" && !(u.Scheme == "ws" && u.Hostname() == "127.0.0.1")) {
		return c, errors.New("LIVEKIT_URL must be wss://, or ws://127.0.0.1 for development")
	}
	return c, nil
}

func encryptionPolicy() (bool, string, error) {
	required := false
	if raw := os.Getenv("VOICECORD_E2EE"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return false, "", errors.New("VOICECORD_E2EE must be true or false")
		}
		required = value
	}
	keyID := os.Getenv("VOICECORD_E2EE_KEY_ID")
	if keyID != "" && (len(keyID) != 64 || strings.Trim(keyID, "0123456789abcdef") != "") {
		return false, "", errors.New("VOICECORD_E2EE_KEY_ID must be a lowercase SHA-256 hex digest")
	}
	return required, keyID, nil
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		if e := standalone(os.Args[2:]); e != nil {
			log.Fatal(e)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "selfhost" {
		if e := selfhost(); e != nil {
			log.Fatal(e)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		raw, e := io.ReadAll(io.LimitReader(os.Stdin, 1026))
		if e != nil {
			log.Fatal(e)
		}
		password := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
		if len(password) < 8 || len(password) > 1024 {
			log.Fatal("password must be 8..1024 bytes")
		}
		salt := make([]byte, 16)
		if _, e = rand.Read(salt); e != nil {
			log.Fatal(e)
		}
		key, e := pbkdf2.Key(sha256.New, password, salt, 600000, 32)
		if e != nil {
			log.Fatal(e)
		}
		fmt.Println("pbkdf2-sha256$" + strconv.Itoa(600000) + "$" + b64.EncodeToString(salt) + "$" + b64.EncodeToString(key))
		return
	}
	c, e := loadConfig()
	if e != nil {
		log.Fatal(e)
	}
	a := &app{cfg: c, attempts: make(map[string]attempt), hashSlots: make(chan struct{}, 4), now: time.Now}
	srv := &http.Server{Addr: c.Listen, Handler: a.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("Voicecord API listening on %s", c.Listen)
	if e = srv.ListenAndServe(); e != nil && !errors.Is(e, http.ErrServerClosed) {
		log.Fatal(e)
	}
}
