package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestChatPagesAndAttachmentLifecycle(t *testing.T) {
	a := testApp(t)
	now := a.now()
	a.now = func() time.Time { return now }
	var err error
	a.chat, err = openChat(":memory:", "transport-only-v2", now)
	if err != nil {
		t.Fatal(err)
	}
	defer a.chat.db.Close()
	call := func(method, path, token string, body []byte, status int) []byte {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		res := httptest.NewRecorder()
		a.handler().ServeHTTP(res, req)
		if res.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, res.Code, res.Body)
		}
		return res.Body.Bytes()
	}
	alice := a.chatToken("Alice", "alice")
	bob := a.chatToken("Bob", "bob")
	imageID := strings.Repeat("a", 32)
	call("POST", "/api/chat/attachments/"+imageID, "", []byte("PNG"), 401)
	call("POST", "/api/chat/attachments/"+imageID, alice, []byte("PNG"), 200)
	call("POST", "/api/chat/attachments/"+imageID, alice, []byte("PNG"), 200)
	call("POST", "/api/chat/attachments/"+imageID, bob, []byte("PNG"), 409)
	call("GET", "/api/chat/attachments/"+imageID, bob, nil, 404)
	packet := chatPacket{RequestID: fmt.Sprintf("%032x", 0), Nonce: []byte{}, Ciphertext: []byte("hello"), AttachmentID: imageID}
	raw, _ := json.Marshal(packet)
	call("POST", "/api/chat", bob, raw, 400)
	call("POST", "/api/chat", alice, raw, 200)
	if got := call("GET", "/api/chat/attachments/"+imageID, bob, nil, 200); string(got) != "PNG" {
		t.Fatal("attachment differs")
	}
	for i := 1; i < 220; i++ {
		now = now.Add(time.Second)
		if _, err := a.chat.post(context.Background(), chatPacket{RequestID: fmt.Sprintf("%032x", i), Nonce: []byte{}, Ciphertext: []byte("text")}, "Alice", "alice", now); err != nil {
			t.Fatal(err)
		}
	}
	type page struct {
		First, Last        int64
		Messages           []chatRecord
		HasOlder, HasNewer bool
		Unread             int
	}
	read := func(query string) page {
		var p page
		if json.Unmarshal(call("GET", "/api/chat?"+query, bob, nil, 200), &p) != nil {
			t.Fatal("invalid page")
		}
		return p
	}
	latest := read("limit=100&readAfter=210")
	if len(latest.Messages) != 100 || latest.Messages[0].ID != 121 || latest.Last != 220 || !latest.HasOlder || latest.HasNewer || latest.Unread != 10 {
		t.Fatalf("latest: %+v", latest)
	}
	older := read("limit=50&before=121")
	if older.Messages[0].ID != 71 || older.Messages[49].ID != 120 || !older.HasNewer {
		t.Fatalf("older: %+v", older)
	}
	newer := read("limit=25&after=120")
	if newer.Messages[0].ID != 121 || newer.Messages[24].ID != 145 {
		t.Fatal("forward page skipped messages")
	}
	around := read("limit=100&around=80")
	if len(around.Messages) != 100 || around.Messages[0].ID > 80 || around.Messages[99].ID < 80 {
		t.Fatal("anchor not in page")
	}
	all := read("limit=500")
	if len(all.Messages) != 220 {
		t.Fatal("custom window capped at 100")
	}
	call("GET", "/api/chat?limit=501", bob, nil, 400)
	call("GET", "/api/chat?limit=100&before=50&after=3", bob, nil, 400)
	call("POST", "/api/chat/attachments/"+strings.Repeat("b", 32), alice, make([]byte, attachmentLimit+1), 413)
	a.cfg.RequireE2EE = true
	packet.RequestID = strings.Repeat("c", 32)
	raw, _ = json.Marshal(packet)
	call("POST", "/api/chat", alice, raw, 401)
	alice = a.chatToken("Alice", "alice")
	call("POST", "/api/chat", alice, raw, 400)
	now = now.Add(30 * 24 * time.Hour)
	if err := a.chat.expire(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	var count int
	if a.chat.db.QueryRow("SELECT COUNT(*) FROM chat_attachments").Scan(&count) != nil || count != 1 {
		t.Fatal("referenced attachment must survive without a time limit")
	}
}

func TestPreviewRequiresRoomAccessAndCountsUnread(t *testing.T) {
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"participants":[{"name":"Alice"},{"name":"Bob"},{"name":"Carol"},{"name":"Dave"}]}`))
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
	for i := 0; i < 3; i++ {
		a.chat.post(context.Background(), chatPacket{RequestID: fmt.Sprintf("%032x", i), Nonce: []byte{}, Ciphertext: []byte("hello")}, "Alice", "alice", a.now())
	}
	handler := a.handler()
	private := httptest.NewRecorder()
	handler.ServeHTTP(private, httptest.NewRequest("GET", "/api/preview?readAfter=0", nil))
	if private.Code != 401 {
		t.Fatal("private preview leaked")
	}
	public := httptest.NewRecorder()
	handler.ServeHTTP(public, httptest.NewRequest("GET", "/api/presence", nil))
	if public.Code != 401 || strings.Contains(public.Body.String(), "Alice") || strings.Contains(public.Body.String(), "participants") {
		t.Fatal("unauthenticated presence leaked activity")
	}
	request := httptest.NewRequest("GET", "/api/preview?readAfter=1&readFeed="+a.chat.feed, nil)
	request.Header.Set("Authorization", "Bearer "+a.chatToken("Bob", "bob"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var body struct {
		Participants, Unread int
		People               []map[string]any
	}
	json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != 200 || body.Participants != 4 || body.Unread != 2 || len(body.People) != 3 {
		t.Fatalf("preview: %d %s", response.Code, response.Body)
	}
}
