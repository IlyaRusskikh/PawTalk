package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPreviewHistoryStartsFresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	keyID := strings.Repeat("a", 64)
	_, err = db.Exec(`
		CREATE TABLE chat_state(id INTEGER PRIMARY KEY, fingerprint TEXT, feed TEXT);
		INSERT INTO chat_state VALUES (1, ?, 'preview');
		CREATE TABLE chat_messages(id INTEGER PRIMARY KEY, author TEXT);
		INSERT INTO chat_messages VALUES (1, 'Preview author');
	`, keyID)
	_ = db.Close()
	if err != nil {
		t.Fatal(err)
	}
	store, err := openChat(path, keyID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	var count int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM chat_messages").Scan(&count); err != nil || count != 0 || store.feed == "preview" {
		t.Fatalf("expected a fresh chat feed: %d, %v", count, err)
	}
}

func TestVerifiedProfileKeepsLatestNameAndAvatarForOfflineHistory(t *testing.T) {
	a := testApp(t)
	keyID := strings.Repeat("b", 64)
	a.cfg.RequireE2EE, a.cfg.E2EEKeyID = true, keyID
	path := filepath.Join(t.TempDir(), "chat.sqlite")
	var err error
	a.chat, err = openChat(path, keyID, a.now())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = a.chat.db.Close() }()
	call := func(method, path, token string, body []byte, status int) []byte {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.RemoteAddr = "192.0.2.1:5000"
		res := httptest.NewRecorder()
		a.handler().ServeHTTP(res, req)
		if res.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, res.Code, res.Body)
		}
		return res.Body.Bytes()
	}
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	join := func(name string) (token, id string) {
		t.Helper()
		var config struct{ ProfileChallenge string }
		if err := json.Unmarshal(call("GET", "/api/config", "", nil, 200), &config); err != nil {
			t.Fatal(err)
		}
		signed := ed25519.Sign(private, []byte("voicecord-profile-v1\n"+config.ProfileChallenge+"\n"+name))
		proof := profileProof{b64.EncodeToString(public), config.ProfileChallenge, b64.EncodeToString(signed)}
		body, _ := json.Marshal(map[string]any{"nickname": name, "password": "test-password", "e2ee": true, "e2eeKeyId": keyID, "profile": proof})
		var join struct{ ChatToken, ProfileID string }
		if err := json.Unmarshal(call("POST", "/api/connect", "", body, 200), &join); err != nil || join.ProfileID == "" {
			t.Fatalf("profile login: %v", err)
		}
		call("POST", "/api/connect", "", body, 403)
		return join.ChatToken, join.ProfileID
	}
	token, id := join("Alice")
	avatar := bytes.Repeat([]byte{7}, 48)
	update := func(nickname string) {
		body, _ := json.Marshal(profileUpdate{Nickname: nickname, Nonce: make([]byte, 12), Ciphertext: avatar})
		call("POST", "/api/chat/profile", token, body, 200)
	}
	update("Alice")
	packet, _ := json.Marshal(chatPacket{RequestID: strings.Repeat("3", 32), Nonce: make([]byte, 12), Ciphertext: make([]byte, 32)})
	call("POST", "/api/chat", token, packet, 200)
	update("Alice renamed")
	if err := a.chat.db.Close(); err != nil {
		t.Fatal(err)
	}
	a.chat, err = openChat(path, keyID, a.now())
	if err != nil {
		t.Fatal(err)
	}
	bob := a.chatToken("Bob", "")
	var history struct {
		Messages []chatRecord
		Profiles []chatProfileRecord
	}
	if err := json.Unmarshal(call("GET", "/api/chat?after=0&profilesAfter=0", bob, nil, 200), &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Messages) != 1 || history.Messages[0].AuthorID != id || len(history.Profiles) != 1 ||
		history.Profiles[0].ID != id || history.Profiles[0].Nickname != "Alice renamed" || !bytes.Equal(history.Profiles[0].Ciphertext, avatar) {
		t.Fatalf("unexpected offline history: %+v", history)
	}
	if _, again := join("Alice again"); again != id {
		t.Fatal("profile ID changed after server restart and rename")
	}
}

func TestChatHistorySurvivesRestartAndRotatesOnKeyChange(t *testing.T) {
	a := testApp(t)
	now := a.now()
	a.now = func() time.Time { return now }
	path := filepath.Join(t.TempDir(), "chat.sqlite")
	restart := func(fingerprint string) {
		t.Helper()
		if a.chat != nil {
			if err := a.chat.db.Close(); err != nil {
				t.Fatal(err)
			}
		}
		a.cfg.RequireE2EE, a.cfg.E2EEKeyID = true, fingerprint
		var err error
		a.chat, err = openChat(path, fingerprint, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	defer func() { _ = a.chat.db.Close() }()
	keyID := strings.Repeat("a", 64)
	restart(keyID)

	join := func(name string) string {
		t.Helper()
		response := request(a, fmt.Sprintf(`{"nickname":%q,"password":"test-password","e2ee":true,"e2eeKeyId":%q}`, name, a.cfg.E2EEKeyID))
		var grant struct{ ChatFeed, ChatToken string }
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &grant) != nil || grant.ChatFeed != a.chat.feed || grant.ChatToken == "" {
			t.Fatalf("join failed: %d %s", response.Code, response.Body)
		}
		return grant.ChatToken
	}
	call := func(method, url, token string, body []byte, status int) []byte {
		t.Helper()
		req := httptest.NewRequest(method, url, bytes.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res := httptest.NewRecorder()
		a.handler().ServeHTTP(res, req)
		if res.Code != status {
			t.Fatalf("%s %s: %d %s", method, url, res.Code, res.Body)
		}
		return res.Body.Bytes()
	}
	packet := chatPacket{RequestID: strings.Repeat("1", 32), Nonce: bytes.Repeat([]byte{2}, 12), Ciphertext: bytes.Repeat([]byte{3}, 40)}
	body, _ := json.Marshal(packet)
	feed := a.chat.feed
	alice := join("Alice")
	call(http.MethodGet, "/api/chat?after=0", "", nil, 401)
	call(http.MethodPost, "/api/chat", alice, []byte(`{"text":"plaintext"}`), 400)
	initial := call(http.MethodPost, "/api/chat", alice, body, 200)

	restart(keyID)
	if a.chat.feed != feed {
		t.Fatal("restart with unchanged fingerprint changed the feed")
	}
	if retry := call(http.MethodPost, "/api/chat", alice, body, 200); !bytes.Equal(retry, initial) {
		t.Fatal("retried send got a different message ID")
	}
	bob := join("Bob")
	history := func(token string, after int64) []chatRecord {
		t.Helper()
		response := call(http.MethodGet, fmt.Sprintf("/api/chat?after=%d", after), token, nil, 200)
		var page struct {
			First    int64
			Messages []chatRecord
		}
		if err := json.Unmarshal(response, &page); err != nil {
			t.Fatal(err)
		}
		return page.Messages
	}
	messages := history(bob, 0)
	if len(messages) != 1 || messages[0].Author != "Alice" || !bytes.Equal(messages[0].Ciphertext, packet.Ciphertext) {
		t.Fatalf("unexpected history: %+v", messages)
	}
	if messages := history(bob, messages[0].ID); len(messages) != 0 {
		t.Fatalf("cursor returned previously fetched messages: %+v", messages)
	}
	restart(strings.Repeat("b", 64))
	if a.chat.feed == feed {
		t.Fatal("rotated key reused the old feed")
	}
	call(http.MethodGet, "/api/chat?after=0", alice, nil, 401)
	if messages := history(join("Bob"), 0); len(messages) != 0 {
		t.Fatal("new key exposed history from an older feed")
	}
	now = now.Add(chatRetention)
	restart(a.cfg.E2EEKeyID)
	var rows int
	if err := a.chat.db.QueryRow("SELECT COUNT(*) FROM chat_messages").Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("retention after restart: rows=%d err=%v", rows, err)
	}
}

func TestChatCapacityAndConflictingRetry(t *testing.T) {
	now := time.Now()
	store, err := openChat(filepath.Join(t.TempDir(), "chat.sqlite"), strings.Repeat("a", 64), now)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	for i := range 502 {
		packet := chatPacket{RequestID: fmt.Sprintf("%032x", i), Nonce: make([]byte, 12), Ciphertext: make([]byte, 32)}
		if _, err := store.post(context.Background(), packet, "Alice", "", now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	var rows, first int
	if err := store.db.QueryRow("SELECT COUNT(*), MIN(id) FROM chat_messages").Scan(&rows, &first); err != nil || rows != 500 || first != 3 {
		t.Fatalf("chat cap: rows=%d first=%d err=%v", rows, first, err)
	}
	conflicting := chatPacket{RequestID: fmt.Sprintf("%032x", 501), Nonce: make([]byte, 12), Ciphertext: bytes.Repeat([]byte{1}, 32)}
	if _, err := store.post(context.Background(), conflicting, "Alice", "", now); !errors.Is(err, errChatConflict) {
		t.Fatalf("conflicting retry: %v", err)
	}
}

func TestChatRateLimit(t *testing.T) {
	now := time.Now()
	store, err := openChat(filepath.Join(t.TempDir(), "chat.sqlite"), strings.Repeat("a", 64), now)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	post := func(i int, author string, at time.Time) error {
		packet := chatPacket{RequestID: fmt.Sprintf("%032x", i), Nonce: make([]byte, 12), Ciphertext: make([]byte, 32)}
		_, err := store.post(context.Background(), packet, author, "", at)
		return err
	}
	for i := range 3 {
		if err := post(i, "Alice", now); err != nil {
			t.Fatal(err)
		}
	}
	if err := post(3, "Alice", now.Add(999*time.Millisecond)); !errors.Is(err, errChatRate) {
		t.Fatalf("fourth message within a second: %v", err)
	}
	if err := post(0, "Alice", now); err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if err := post(4, "Bob", now); err != nil {
		t.Fatalf("independent author: %v", err)
	}
	if err := post(3, "Alice", now.Add(time.Second)); err != nil {
		t.Fatalf("message after the window expired: %v", err)
	}
}
