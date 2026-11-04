package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) *app {
	t.Helper()
	salt := bytes.Repeat([]byte{7}, 16)
	key, e := pbkdf2.Key(sha256.New, "test-password", salt, 600000, 32)
	if e != nil {
		t.Fatal(e)
	}
	return &app{cfg: config{APIKey: "test-key", APISecret: strings.Repeat("s", 32), LivekitURL: "wss://203.0.113.10/rtc", PasswordHash: "pbkdf2-sha256$600000$" + b64.EncodeToString(salt) + "$" + b64.EncodeToString(key)}, attempts: make(map[string]attempt), hashSlots: make(chan struct{}, 4), now: func() time.Time { return time.Unix(1800000000, 0) }}
}
func request(a *app, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/connect", strings.NewReader(body))
	r.RemoteAddr = "198.51.100.1:1234"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w
}
func TestConnectAndGrants(t *testing.T) {
	a := testApp(t)
	ids := map[string]bool{}
	for i := 0; i < 2; i++ {
		w := request(a, `{"nickname":"Друг","password":"test-password"}`)
		if w.Code != 200 {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		var result struct{ Token, Identity, URL string }
		if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
			t.Fatal(e)
		}
		if ids[result.Identity] || result.Identity == "" {
			t.Fatal("identities must be unique even with duplicate nicknames")
		}
		ids[result.Identity] = true
		parts := strings.Split(result.Token, ".")
		if len(parts) != 3 {
			t.Fatal("not JWT")
		}
		mac := hmac.New(sha256.New, []byte(a.cfg.APISecret))
		mac.Write([]byte(parts[0] + "." + parts[1]))
		sig, _ := b64.DecodeString(parts[2])
		if !hmac.Equal(sig, mac.Sum(nil)) {
			t.Fatal("invalid signature")
		}
		payload, _ := b64.DecodeString(parts[1])
		var claims struct {
			Sub, Name, Iss string
			Exp, Nbf       int64
			Video          struct {
				Room                                               string
				RoomJoin, CanPublish, CanSubscribe, CanPublishData bool
				CanPublishSources                                  []string
			}
		}
		if e := json.Unmarshal(payload, &claims); e != nil {
			t.Fatal(e)
		}
		if claims.Sub != result.Identity || claims.Name != "Друг" || claims.Iss != a.cfg.APIKey || claims.Exp != a.now().Unix()+300 || claims.Nbf > a.now().Unix() {
			t.Fatalf("bad claims: %+v", claims)
		}
		grant := claims.Video
		if grant.Room != "common" || !grant.RoomJoin || !grant.CanPublish || !grant.CanSubscribe || !grant.CanPublishData || len(grant.CanPublishSources) != 1 || grant.CanPublishSources[0] != "microphone" {
			t.Fatalf("unsafe grants: %+v", grant)
		}
		if strings.Contains(w.Body.String(), "test-password") || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("credentials/cache leak")
		}
	}
}
func TestBadRequests(t *testing.T) {
	a := testApp(t)
	for _, tc := range []struct {
		body string
		code int
	}{
		{`{"nickname":"x","password":"wrong"}`, 401},
		{`{"nickname":"  ","password":"test-password"}`, 400},
		{`{"nickname":"x\ny","password":"test-password"}`, 400},
		{`{"nickname":"x","password":"test-password","admin":true}`, 400},
		{`{"nickname":"x","password":"test-password"}{}`, 400},
	} {
		w := request(a, tc.body)
		if w.Code != tc.code {
			t.Fatalf("%s: got %d want %d", tc.body, w.Code, tc.code)
		}
	}
	if w := request(a, `{}`); w.Code != 429 {
		t.Fatalf("rate limit: %d", w.Code)
	}
}
func TestRateLimitExpiryAndProxyTrust(t *testing.T) {
	a := testApp(t)
	for i := 0; i < 5; i++ {
		if !a.allow("ip") {
			t.Fatal("limited early")
		}
	}
	if a.allow("ip") {
		t.Fatal("not limited")
	}
	a.now = func() time.Time { return time.Unix(1800000061, 0) }
	if !a.allow("ip") {
		t.Fatal("window did not expire")
	}
	for i := 0; i < 6; i++ {
		r := httptest.NewRequest("POST", "/api/connect", strings.NewReader(`{}`))
		r.RemoteAddr = "198.51.100.2:1"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Real-IP", "192.0.2."+string(rune('1'+i)))
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if i == 5 && w.Code != 429 {
			t.Fatal("untrusted proxy header bypassed limit")
		}
	}
}
func TestHashAndHealth(t *testing.T) {
	a := testApp(t)
	if !verifyPassword(a.cfg.PasswordHash, "test-password") || verifyPassword(a.cfg.PasswordHash, "other") {
		t.Fatal("password verification")
	}
	for _, value := range []string{"", "pbkdf2-sha256$1$x$y", "pbkdf2-sha256$600000$x$y"} {
		if _, _, e := parseHash(value); e == nil {
			t.Fatal("accepted invalid hash")
		}
	}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	a.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/connect", nil))
	if w.Code != 405 {
		t.Fatal("wrong method accepted")
	}
}
