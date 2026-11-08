package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestChatStorageConfiguration(t *testing.T) {
	for _, item := range []struct {
		raw      string
		expected int64
		bad      bool
	}{
		{"", 128 * 1024 * 1024, false}, {"0", 0, false}, {"32", 32 * 1024 * 1024, false}, {"-1", 0, true}, {"1.5", 0, true}, {"oops", 0, true}, {"9223372036854775807", 0, true},
	} {
		t.Setenv("PAWTALK_CHAT_MAX_MB", item.raw)
		got, err := chatStorageLimit()
		if (err != nil) != item.bad || (!item.bad && got != item.expected) {
			t.Fatalf("%q: %d %v", item.raw, got, err)
		}
	}
}

func TestLongHistoryProfilesRemainPaged(t *testing.T) {
	store, err := openChat(":memory:", "key", time.Now(), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	tx, err := store.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for i := range 700 {
		if _, err = tx.Exec("INSERT INTO chat_profiles(feed,profile_id,nickname,updated) VALUES (?,?,?,?)", store.feed, fmt.Sprintf("%064x", i), "Alice", time.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	first, err := readProfiles(context.Background(), tx, store.feed, 0)
	if err != nil || len(first) != 500 {
		t.Fatalf("first profile page: %d %v", len(first), err)
	}
	second, err := readProfiles(context.Background(), tx, store.feed, first[499].Revision)
	if err != nil || len(second) != 200 || second[0].Revision <= first[499].Revision {
		t.Fatalf("second profile page: %d %v", len(second), err)
	}
}

func TestChatStoragePhysicalBudgetAndRestartDecrease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.sqlite")
	now := time.Now().Add(-90 * 24 * time.Hour)
	store, err := openChat(path, "test-key", now, 0)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 700 {
		_, err = store.post(context.Background(), chatPacket{RequestID: fmt.Sprintf("%032x", i), Nonce: make([]byte, 12), Ciphertext: bytes.Repeat([]byte{1}, 4000)}, "Alice", "", now.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
	}
	if err = store.expire(context.Background(), time.Now()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = store.db.QueryRow("SELECT COUNT(*) FROM chat_messages").Scan(&count); err != nil || count != 700 {
		t.Fatalf("unlimited history: %d %v", count, err)
	}
	if stat, err := os.Stat(path); err != nil || stat.Size() <= 1024*1024 {
		t.Fatal("zero must permit a database larger than 1 MiB", err)
	}
	// Simulate a database created by older builds without disk-page reclamation.
	if _, err = store.db.Exec("PRAGMA auto_vacuum=NONE; VACUUM"); err != nil {
		t.Fatal(err)
	}
	store.db.Close()
	store, err = openChat(path, "test-key", time.Now(), 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	var vacuum int
	if err = store.db.QueryRow("PRAGMA auto_vacuum").Scan(&vacuum); err != nil || vacuum != 1 {
		t.Fatalf("old database migration: %d %v", vacuum, err)
	}
	for i := 700; i < 850; i++ {
		_, err = store.post(context.Background(), chatPacket{RequestID: fmt.Sprintf("%032x", i), Nonce: make([]byte, 12), Ciphertext: bytes.Repeat([]byte{2}, 4000)}, "Alice", "", now.Add(time.Duration(i)*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if stat, err := os.Stat(path); err != nil || stat.Size() > 1024*1024 {
			t.Fatalf("physical database exceeds configured budget: %v %v", stat, err)
		}
	}
	var first, last int64
	if err = store.db.QueryRow("SELECT COUNT(*),MIN(id),MAX(id) FROM chat_messages").Scan(&count, &first, &last); err != nil || count >= 700 || first <= 1 || last != 850 {
		t.Fatalf("oldest-first retention: count=%d first=%d last=%d err=%v", count, first, last, err)
	}
}

func TestChatStorageBudgetIncludesAttachmentsAndRollsBackOversizedUploads(t *testing.T) {
	a := testApp(t)
	var err error
	path := filepath.Join(t.TempDir(), "history.sqlite")
	a.chat, err = openChat(path, strings.Repeat("a", 64), a.now(), 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer a.chat.db.Close()
	token := a.chatToken("Alice", "alice")
	call := func(method, path string, body []byte, status int) {
		t.Helper()
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body)
		}
	}
	for i := 1; i <= 2; i++ {
		id := fmt.Sprintf("%032x", i)
		call("POST", "/api/chat/attachments/"+id, bytes.Repeat([]byte{byte(i)}, 700*1024), 200)
		raw, _ := json.Marshal(chatPacket{RequestID: id, Nonce: make([]byte, 12), Ciphertext: make([]byte, 32), AttachmentID: id})
		call("POST", "/api/chat", raw, 200)
	}
	call("GET", "/api/chat/attachments/"+fmt.Sprintf("%032x", 1), nil, 404)
	call("GET", "/api/chat/attachments/"+fmt.Sprintf("%032x", 2), nil, 200)
	call("POST", "/api/chat/attachments/"+fmt.Sprintf("%032x", 3), make([]byte, 2*1024*1024), 507)
	// The failed upload must not commit the speculative eviction of existing history.
	call("GET", "/api/chat/attachments/"+fmt.Sprintf("%032x", 2), nil, 200)
	var count int
	if err = a.chat.db.QueryRow("SELECT COUNT(*) FROM chat_messages").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	if stat, err := os.Stat(path); err != nil || stat.Size() > 1024*1024 {
		t.Fatalf("attachment database budget: %v %v", stat, err)
	}
}
