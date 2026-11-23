package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCommittedMessageWebSocketPayloadsAndLegacyMetadata(t *testing.T) {
	s := testMembershipStore(t)
	owner := bootstrapTestServer(t, s, newTestMemberSigner(9))
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	server := httptest.NewServer(newMembershipHandler(s, config{}))
	defer server.Close()
	open := func(path string) (net.Conn, *bufio.Reader) {
		t.Helper()
		c, err := net.Dial("tcp", server.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		c.SetDeadline(time.Now().Add(8 * time.Second))
		fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", path, server.Listener.Addr(), owner.Token)
		r := bufio.NewReader(c)
		res, err := http.ReadResponse(r, nil)
		if err != nil || res.StatusCode != 101 {
			t.Fatal("upgrade", err)
		}
		return c, r
	}
	frame := func(r *bufio.Reader) (memberEvent, []byte) {
		t.Helper()
		var h [2]byte
		if _, err := io.ReadFull(r, h[:]); err != nil {
			t.Fatal(err)
		}
		n := int(h[1])
		if n == 126 {
			var ext [2]byte
			io.ReadFull(r, ext[:])
			n = int(binary.BigEndian.Uint16(ext[:]))
		}
		if n > 60000 {
			t.Fatal("frame bound")
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(r, data); err != nil {
			t.Fatal(err)
		}
		var event memberEvent
		if json.Unmarshal(data, &event) != nil {
			t.Fatal("invalid JSON")
		}
		return event, data
	}
	c, r := open("/api/v2/events/messages")
	defer c.Close()
	legacy, old := open("/api/v2/events")
	defer legacy.Close()
	frame(r)
	frame(old)
	call := func(method, path string, body any) map[string]any {
		t.Helper()
		data, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, server.URL+path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+owner.Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var value map[string]any
		json.NewDecoder(res.Body).Decode(&value)
		if res.StatusCode >= 300 {
			t.Fatal("HTTP mutation", res.StatusCode, value)
		}
		return value
	}
	input := testMessage('a')
	input.Ciphertext = b64.EncodeToString(bytes.Repeat([]byte{1}, 12000))
	result := call("POST", "/api/v2/channels/"+channel+"/messages", input)
	id := int64(result["id"].(float64))
	event, raw := frame(r)
	if !event.Delivery || event.Previous != 0 || event.Revision != 1 || len(event.Messages) != 1 || event.Messages[0].Ciphertext != input.Ciphertext || len(raw) <= 2048 {
		t.Fatal("full encrypted envelope not delivered")
	}
	oldEvent, oldRaw := frame(old)
	if oldEvent.Delivery || len(oldEvent.Messages) != 0 || len(oldRaw) > 2048 || bytes.Contains(oldRaw, []byte("ciphertext")) {
		t.Fatal("legacy stream received content")
	}
	edited := input
	edited.RequestID = strings.Repeat("b", 32)
	edited.Ciphertext = testMessage('b').Ciphertext
	call("PATCH", fmt.Sprintf("/api/v2/messages/%d", id), edited)
	event, _ = frame(r)
	frame(old)
	if event.Previous != 1 || event.Revision != 2 || event.Messages[0].RequestID != input.RequestID || event.Messages[0].Ciphertext != edited.Ciphertext {
		t.Fatal("edit changed immutable context or lost body")
	}
	call("DELETE", fmt.Sprintf("/api/v2/messages/%d", id), map[string]string{"requestId": strings.Repeat("c", 32)})
	event, raw = frame(r)
	frame(old)
	if event.Previous != 2 || event.Revision != 3 || event.Last != 0 || event.First != 0 || len(event.Deleted) != 1 || event.Deleted[0].ID != id || !bytes.Contains(raw, []byte(`"first":0`)) {
		t.Fatal("deletion/empty channel bounds missing")
	}
	if _, err := s.db.Exec("DELETE FROM sessions"); err != nil {
		t.Fatal(err)
	}
	s.events.notify()
	var closeHeader [2]byte
	if _, err := io.ReadFull(r, closeHeader[:]); err != nil || closeHeader[0]&15 != 8 {
		t.Fatal("revoked payload stream stayed open", err)
	}

}

func TestFailedMessageTransactionDoesNotPublishOrLeakPlans(t *testing.T) {
	s := testMembershipStore(t)
	owner := bootstrapTestServer(t, s, newTestMemberSigner(10))
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	wake, off, _ := s.events.subscribeStream("observer", "", true, false)
	defer off()
	s.maxBytes = 1
	if _, err := s.postMessage(context.Background(), owner.Token, channel, testMessage('a')); err == nil {
		t.Fatal("expected storage failure")
	}
	if len(s.events.drain(wake)) != 0 {
		t.Fatal("uncommitted content escaped")
	}
	if len(s.deliveries.plans) != 0 {
		t.Fatal("rollback left buffered content")
	}
	var count int
	s.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&count)
	if count != 0 {
		t.Fatal("failed post was persisted")
	}
}
func TestPayloadQueueByteBudgetForcesResync(t *testing.T) {
	var events chatEvents
	wake, off, _ := events.subscribeStream("slow", "", true, false)
	defer off()
	for i := int64(1); i <= 30; i++ {
		events.publish(memberEvent{Type: "chat", ChannelID: strings.Repeat("a", 32), Delivery: true, Previous: i - 1, Revision: i, Messages: []memberMessage{{ID: i, Ciphertext: strings.Repeat("a", 12000)}}})
	}
	batch := events.drain(wake)
	if len(batch) != 1 || batch[0].Type != "resync" || len(batch[0].wire) > 60000 {
		t.Fatal("slow consumer queue was not bounded")
	}
}
