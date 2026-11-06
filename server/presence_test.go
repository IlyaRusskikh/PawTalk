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
	a := &app{cfg: config{PresenceURL: media.URL, APIKey: "test", APISecret: "secret"}}
	handler := a.handler()
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/presence", nil))
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
		a := &app{cfg: config{PresenceURL: media.URL}}
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/presence", nil))
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
