package main

import (
	"bufio"
	"bytes"
	"context"
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

func TestChatWebSocketInvalidationAndRevocation(t *testing.T) {
	s := testMembershipStore(t)
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	handler := newMembershipHandler(s, config{})
	server := httptest.NewServer(handler)
	defer server.Close()
	path := "/api/v2/channels/" + channel + "/events"
	for _, token := range []string{"", strings.Repeat("x", 43)} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code == 101 || w.Code == 200 {
			t.Fatal("unauthorized socket", w.Code)
		}
	}
	conn, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", path, server.Listener.Addr(), owner.Token)
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != 101 {
		t.Fatal("upgrade", response, err)
	}
	frame := func() (byte, string) {
		t.Helper()
		var h [2]byte
		if _, err := io.ReadFull(reader, h[:]); err != nil {
			t.Fatal(err)
		}
		data := make([]byte, int(h[1]&127))
		if _, err := io.ReadFull(reader, data); err != nil {
			t.Fatal(err)
		}
		return h[0] & 15, string(data)
	}
	if op, data := frame(); op != 1 || data != "changed" {
		t.Fatal("initial catchup", op, data)
	}
	body, _ := json.Marshal(testMessage('b'))
	request, _ := http.NewRequest("POST", server.URL+"/api/v2/channels/"+channel+"/messages", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+owner.Token)
	request.Header.Set("Content-Type", "application/json")
	start := time.Now()
	res, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode >= 300 {
		t.Fatal("post", res.StatusCode)
	}
	if op, data := frame(); op != 1 || data != "changed" || time.Since(start) > time.Second {
		t.Fatal("instant post invalidation", op, data)
	}
	// A live session cannot outlast its authenticated access, even on an open TCP connection.
	if _, err = s.db.ExecContext(context.Background(), "DELETE FROM sessions"); err != nil {
		t.Fatal(err)
	}
	s.events.notify()
	if op, _ := frame(); op != 8 {
		t.Fatal("revoked socket remained open", op)
	}
}
func TestChatWebSocketHandshakeAndLimits(t *testing.T) {
	s := testMembershipStore(t)
	owner := bootstrapTestServer(t, s, newTestMemberSigner(2))
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	handler := newMembershipHandler(s, config{})
	for _, origin := range []string{"", "https://foreign.invalid"} {
		r := httptest.NewRequest("GET", "/api/v2/channels/"+channel+"/events", nil)
		r.Header.Set("Authorization", "Bearer "+owner.Token)
		r.Header.Set("Origin", origin)
		r.Header.Set("Connection", "Upgrade")
		r.Header.Set("Upgrade", "websocket")
		r.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
		r.Header.Set("Sec-WebSocket-Version", "13")
		if origin == "" {
			r.Header.Set("Sec-WebSocket-Version", "12")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal("invalid handshake accepted", w.Code)
		}
	}
	var events chatEvents
	_, off, ok := events.subscribe("device")
	if !ok {
		t.Fatal("subscribe")
	}
	defer off()
	_, off2, ok := events.subscribe("device")
	if !ok {
		t.Fatal("second subscribe")
	}
	defer off2()
	if _, _, ok = events.subscribe("device"); ok {
		t.Fatal("unbounded subscriptions")
	}
}

func TestChatWebSocketControlFrameBounds(t *testing.T) {
	for _, c := range []struct {
		name  string
		frame []byte
		want  bool
	}{
		{"masked ping", []byte{0x89, 0x83, 1, 2, 3, 4, 96, 96, 96}, true},
		{"unmasked", []byte{0x89, 0}, false},
		{"fragmented", []byte{0x09, 0x80}, false},
		{"oversized declaration", []byte{0x89, 0xfe}, false},
		{"client application data", []byte{0x81, 0x80}, false},
		{"invalid close code", []byte{0x88, 0x82, 0, 0, 0, 0, 3, 237}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			conn, peer := net.Pipe()
			defer conn.Close()
			defer peer.Close()
			out := make(chan wsControl, 4)
			readWSControls(conn, bufio.NewReader(bytes.NewReader(c.frame)), out)
			if (len(out) == 1) != c.want {
				t.Fatal("unexpected accepted control", len(out))
			}
			if c.want {
				control := <-out
				if control.op != 9 || string(control.data) != "abc" {
					t.Fatal("masked payload", control)
				}
			}
		})
	}
}

func TestServerEventScopeCoalescingAndOverflow(t *testing.T) {
	var events chatEvents
	wide, off, _ := events.subscribe("wide")
	defer off()
	a, offA, _ := events.subscribeChannel("narrow-a", strings.Repeat("a", 32))
	defer offA()
	b, offB, _ := events.subscribeChannel("narrow-b", strings.Repeat("b", 32))
	defer offB()
	for i := int64(1); i <= 3; i++ {
		events.publish(memberEvent{Type: "chat", ChannelID: strings.Repeat("a", 32), Revision: i, Last: i, Rescan: i == 2})
	}
	if len(b) != 0 {
		t.Fatal("unrelated legacy channel woke")
	}
	for _, wake := range []chan struct{}{wide, a} {
		batch := events.drain(wake)
		if len(batch) != 1 || batch[0].Revision != 3 || !batch[0].Rescan {
			t.Fatal("coalesced edit lost", batch)
		}
	}
	for i := 0; i < 70; i++ {
		events.publish(memberEvent{Type: "chat", ChannelID: fmt.Sprintf("%032x", i), Revision: 1})
	}
	batch := events.drain(wide)
	if len(batch) != 1 || batch[0].Type != "resync" || batch[0].Sequence != events.sequence {
		t.Fatal("overflow did not retain a bounded current checkpoint", batch)
	}
}
func TestServerEventSequenceAndPresenceExpiry(t *testing.T) {
	s := testMembershipStore(t)
	owner := bootstrapTestServer(t, s, newTestMemberSigner(3))
	clock := s.now()
	s.now = func() time.Time { return clock }
	wake, off, _ := s.events.subscribe("observer")
	defer off()
	s.refreshPresenceEvents(context.Background())
	if len(s.events.drain(wake)) != 1 {
		t.Fatal("initial online transition")
	}
	s.refreshPresenceEvents(context.Background())
	if len(s.events.drain(wake)) != 0 {
		t.Fatal("unchanged presence generated traffic")
	}
	clock = clock.Add(46 * time.Second)
	s.refreshPresenceEvents(context.Background())
	batch := s.events.drain(wake)
	if len(batch) != 1 || batch[0].Type != "state" {
		t.Fatal("offline expiry did not invalidate roster")
	}
	handler := newMembershipHandler(s, config{})
	r := httptest.NewRequest("GET", "/api/v2/events/status", nil)
	r.Header.Set("Authorization", "Bearer "+owner.Token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	var status struct{ Sequence uint64 }
	json.Unmarshal(w.Body.Bytes(), &status)
	if w.Code != 200 || status.Sequence != s.events.sequence {
		t.Fatal("sequence checkpoint", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/v2/events/status", nil))
	if w.Code == 200 {
		t.Fatal("unauthenticated checkpoint")
	}
}

func TestPollReadCompletionPublishesResync(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	owner := bootstrapTestServer(t, s, newTestMemberSigner(5))
	clock := s.now()
	s.now = func() time.Time { return clock }
	var channel string
	s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel)
	input := newPollMessage('a', false, true, false)
	if _, err := s.postMessage(ctx, owner.Token, channel, input); err != nil {
		t.Fatal(err)
	}
	wake, off, _ := s.events.subscribe("observer")
	defer off()
	clock = clock.Add(2 * time.Hour)
	if _, err := s.pollState(ctx, owner.Token, input.RequestID); err != nil {
		t.Fatal(err)
	}
	events := s.events.drain(wake)
	if len(events) != 1 || events[0].Type != "resync" {
		t.Fatal("GET completion changed history without invalidating", events)
	}
}
