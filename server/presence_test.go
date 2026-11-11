package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPresenceAggregateAndCache(t *testing.T) {
	calls := 0
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/twirp/livekit.RoomService/ListParticipants" || r.Method != "POST" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Error("invalid media request")
		}
		w.Write([]byte(`{"participants":[{"identity":"private-a"},{"identity":"private-b"}]}`))
	}))
	defer media.Close()
	a := testApp(t)
	a.cfg.PresenceURL = media.URL
	var err error
	a.chat, err = openChat(":memory:", "transport-only-v2", a.now())
	if err != nil {
		t.Fatal(err)
	}
	defer a.chat.db.Close()
	handler := a.handler()
	for _, token := range []string{"", "Bearer invalid"} {
		request := httptest.NewRequest("GET", "/api/presence", nil)
		request.Header.Set("Authorization", token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 401 || calls != 0 {
			t.Fatal("presence queried media before authorization")
		}
	}
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/api/presence", nil)
		request.Header.Set("Authorization", "Bearer "+a.chatToken("Preview", ""))
		handler.ServeHTTP(w, request)
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"participants":2}` {
			t.Fatalf("unexpected presence: %d %s", w.Code, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Error("public response must not be stored")
		}
	}
	if calls != 1 {
		t.Fatalf("cache made %d calls", calls)
	}
}

func TestPresenceUnknownAndEmpty(t *testing.T) {
	for _, status := range []int{404, 503} {
		media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			w.Write([]byte(`{"code":"not_found"}`))
		}))
		a := testApp(t)
		a.cfg.PresenceURL = media.URL
		var err error
		a.chat, err = openChat(":memory:", "transport-only-v2", a.now())
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		request := httptest.NewRequest("GET", "/api/presence", nil)
		request.Header.Set("Authorization", "Bearer "+a.chatToken("Preview", ""))
		a.handler().ServeHTTP(w, request)
		a.chat.db.Close()
		media.Close()
		want := 200
		if status == 503 {
			want = 503
		}
		if w.Code != want {
			t.Fatalf("media %d: got %d", status, w.Code)
		}
	}
}

func TestPasswordRotationRevokesPresenceIncludingWarmCache(t *testing.T) {
	calls := 0
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{"participants":[{"name":"Private Alice"}]}`))
	}))
	defer media.Close()
	a := testApp(t)
	a.cfg.PresenceURL = media.URL
	var err error
	a.chat, err = openChat(":memory:", "transport-only-v2", a.now())
	if err != nil {
		t.Fatal(err)
	}
	defer a.chat.db.Close()
	handler := a.handler()
	read := func(path, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	old := a.chatToken("Former member", "")
	if read("/api/presence", old).Code != 200 || read("/api/preview?readAfter=0", old).Code != 200 {
		t.Fatal("valid initial authorization failed")
	}
	a.cfg.PasswordHash, err = passwordHash("new-private-password")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/presence", "/api/preview?readAfter=0"} {
		for _, token := range []string{"", old, "invalid"} {
			w := read(path, token)
			if w.Code != 401 || strings.Contains(w.Body.String(), "participants") || strings.Contains(w.Body.String(), "Alice") {
				t.Fatal("revoked access exposed cached activity", w.Code, w.Body.String())
			}
		}
	}
	if calls != 1 {
		t.Fatal("unauthorized requests reached media")
	}
	if read("/api/presence", a.chatToken("Current member", "")).Code != 200 {
		t.Fatal("current credentials rejected")
	}
	beforePolicy := a.chatToken("Old E2EE policy", "")
	a.cfg.RequireE2EE = true
	a.cfg.E2EEKeyID = strings.Repeat("e", 64)
	if read("/api/presence", beforePolicy).Code != 401 {
		t.Fatal("changed E2EE policy did not revoke presence access")
	}
}
