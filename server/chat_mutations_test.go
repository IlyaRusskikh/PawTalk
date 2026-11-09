package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMessageMutationsAuthorizeAndSynchronize(t *testing.T) {
	for _, encrypted := range []bool{false, true} {
		t.Run(map[bool]string{false: "transport", true: "encrypted"}[encrypted], func(t *testing.T) {
			a := testApp(t)
			a.cfg.RequireE2EE = encrypted
			var err error
			a.chat, err = openChat(":memory:", "test", a.now())
			if err != nil {
				t.Fatal(err)
			}
			defer a.chat.db.Close()
			owner, other := strings.Repeat("a", 64), strings.Repeat("b", 64)
			packet := chatPacket{RequestID: strings.Repeat("c", 32), Nonce: []byte{}, Ciphertext: []byte("before")}
			if encrypted {
				packet.Nonce = bytes.Repeat([]byte{1}, 12)
				packet.Ciphertext = bytes.Repeat([]byte{2}, 32)
			}
			id, err := a.chat.post(context.Background(), packet, "Alice", owner, a.now())
			if err != nil {
				t.Fatal(err)
			}
			call := func(method, path, token string, body any, status int) []byte {
				t.Helper()
				raw, _ := json.Marshal(body)
				req := httptest.NewRequest(method, path, bytes.NewReader(raw))
				req.Header.Set("Authorization", "Bearer "+token)
				res := httptest.NewRecorder()
				a.handler().ServeHTTP(res, req)
				if res.Code != status {
					t.Fatalf("%s %s: %d %s", method, path, res.Code, res.Body)
				}
				return res.Body.Bytes()
			}
			mutation := map[string]any{"id": id, "packet": packet}
			call("POST", "/api/chat/mutate", "invalid", mutation, 401)
			call("POST", "/api/chat/mutate", a.chatToken("Alice", other), mutation, 403)
			call("POST", "/api/chat/mutate", a.chatToken("Alice", ""), mutation, 403)
			bad := packet
			bad.RequestID = strings.Repeat("d", 32)
			call("POST", "/api/chat/mutate", a.chatToken("Renamed", owner), map[string]any{"id": id, "packet": bad}, 400)
			bad = packet
			bad.AttachmentID = strings.Repeat("e", 32)
			call("POST", "/api/chat/mutate", a.chatToken("Alice", owner), map[string]any{"id": id, "packet": bad}, 400)
			packet.Ciphertext = []byte("changed content that is long enough for ciphertext")
			mutation["packet"] = packet
			token := a.chatToken("Renamed", owner)
			call("POST", "/api/chat/mutate", token, mutation, 200)
			var page struct{ Messages []chatRecord }
			if err := json.Unmarshal(call("GET", "/api/chat?limit=500&ids=1", token, nil, 200), &page); err != nil {
				t.Fatal(err)
			}
			if len(page.Messages) != 1 || page.Messages[0].ID != id || !bytes.Equal(page.Messages[0].Ciphertext, packet.Ciphertext) {
				t.Fatalf("edit not synchronized: %+v", page)
			}
			var snapshot struct{ Digest string }
			json.Unmarshal(call("GET", "/api/chat?limit=500&ids=1", token, nil, 200), &snapshot)
			var unchanged struct{ Unchanged bool }
			json.Unmarshal(call("GET", "/api/chat?limit=500&ids=1&digest="+snapshot.Digest, token, nil, 200), &unchanged)
			if !unchanged.Unchanged {
				t.Fatal("unchanged sync resent the message window")
			}
			call("POST", "/api/chat/mutate", token, map[string]any{"id": id}, 200)
			var changed struct {
				Unchanged bool
				Messages  []chatRecord
			}
			json.Unmarshal(call("GET", "/api/chat?limit=500&ids=1&digest="+snapshot.Digest, token, nil, 200), &changed)
			if changed.Unchanged || len(changed.Messages) != 0 {
				t.Fatal("deletion did not invalidate sync digest")
			}
			if err := json.Unmarshal(call("GET", "/api/chat?limit=500&ids=1", token, nil, 200), &page); err != nil {
				t.Fatal(err)
			}
			if len(page.Messages) != 0 {
				t.Fatal("deleted message returned in sync")
			}
			call("POST", "/api/chat/mutate", token, map[string]any{"id": id}, 404)
		})
	}
}
