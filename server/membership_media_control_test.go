package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestMembershipModerationRequestsScopedMediaRemoval(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
	member := newTestMemberSigner(2)
	mi := activateTestMember(t, s, member, "member")
	ms := loginTestMember(t, s, member)
	var mu sync.Mutex
	calls := []string{}
	rooms := []string{}
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		if len(parts) != 3 {
			t.Error("unsigned media-control call")
			w.WriteHeader(401)
			return
		}
		raw, _ := b64.DecodeString(parts[1])
		var claims map[string]any
		json.Unmarshal(raw, &claims)
		video, ok := claims["video"].(map[string]any)
		if !ok || video["roomAdmin"] != true || video["room"] != body["room"] {
			t.Error("media control not room scoped")
		}
		mu.Lock()
		calls = append(calls, r.URL.Path)
		rooms = append(rooms, body["room"])
		mu.Unlock()
		w.WriteHeader(200)
		w.Write([]byte(`{}`))
	}))
	defer media.Close()
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("s", 32), PresenceURL: media.URL, LivekitURL: "wss://127.0.0.1/rtc"}
	server := httptest.NewServer(newMembershipHandler(s, cfg))
	defer server.Close()
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_voice'").Scan(&channel)
	grant, err := s.joinVoice(ctx, ms.Token, channel, cfg)
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest("POST", server.URL+"/api/v2/members/"+mi.ProfileID+"/kick", bytes.NewBufferString(`{"requestId":"11111111111111111111111111111111"}`))
	request.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("anonymous kick allowed")
	}
	mu.Lock()
	count := len(calls)
	mu.Unlock()
	if count != 0 {
		t.Fatal("unauthorized operation reached media API")
	}
	request, _ = http.NewRequest("POST", server.URL+"/api/v2/members/"+mi.ProfileID+"/kick", bytes.NewBufferString(`{"requestId":"22222222222222222222222222222222"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+admin.Token)
	response, err = server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("kick failed", response.StatusCode)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 1 || !strings.HasSuffix(calls[0], "/RemoveParticipant") || rooms[0] != grant.Room {
		t.Fatal("wrong media removal", calls, rooms)
	}
}
