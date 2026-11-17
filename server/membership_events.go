package main

import (
	"bufio"
	"context"
	"crypto/sha1" // RFC 6455 handshake, not an identity primitive.
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Coalesced invalidations carry no plaintext, ciphertext or user identities.
// HTTP reads remain the authenticated source of history and poll data.
type memberEvent struct {
	Sequence  uint64 `json:"sequence"`
	Type      string `json:"type"`
	ChannelID string `json:"channelId,omitempty"`
	Revision  int64  `json:"revision"`
	Last      int64  `json:"last"`
	Rescan    bool   `json:"rescan,omitempty"`
}
type eventSubscription struct {
	device, channel string
	pending         map[string]memberEvent
}
type chatEvents struct {
	mu          sync.Mutex
	sequence    uint64
	presence    int64
	retention   bool
	subscribers map[chan struct{}]*eventSubscription
}

func (e *chatEvents) subscribe(device string) (chan struct{}, func(), bool) {
	return e.subscribeChannel(device, "")
}
func (e *chatEvents) subscribeChannel(device, channel string) (chan struct{}, func(), bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.subscribers) >= 8192 {
		return nil, nil, false
	}
	count := 0
	for _, sub := range e.subscribers {
		if sub.device == device {
			count++
		}
	}
	if count >= 2 {
		return nil, nil, false
	}
	if e.subscribers == nil {
		e.subscribers = make(map[chan struct{}]*eventSubscription)
	}
	ch := make(chan struct{}, 1)
	e.subscribers[ch] = &eventSubscription{device: device, channel: channel, pending: make(map[string]memberEvent)}
	return ch, func() { e.mu.Lock(); delete(e.subscribers, ch); e.mu.Unlock() }, true
}
func (e *chatEvents) publish(event memberEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.sequence++
	event.Sequence = e.sequence
	for wake, sub := range e.subscribers {
		if sub.channel != "" && event.ChannelID != "" && event.ChannelID != sub.channel {
			continue
		}
		queued := event
		key := event.Type + event.ChannelID
		if old, ok := sub.pending[key]; ok {
			queued.Rescan = event.Rescan || old.Rescan
		}
		if event.Type == "resync" || len(sub.pending) >= 64 {
			clear(sub.pending)
			sub.pending["resync"] = memberEvent{Type: "resync", Sequence: event.Sequence}
		} else if full, ok := sub.pending["resync"]; ok {
			full.Sequence = event.Sequence
			sub.pending["resync"] = full
		} else {
			sub.pending[key] = queued
		}
		select {
		case wake <- struct{}{}:
		default:
		}
	}
}
func (e *chatEvents) notify() { e.publish(memberEvent{Type: "resync"}) }
func (e *chatEvents) drain(wake chan struct{}) []memberEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	sub := e.subscribers[wake]
	if sub == nil {
		return nil
	}
	events := make([]memberEvent, 0, len(sub.pending))
	for _, event := range sub.pending {
		events = append(events, event)
	}
	clear(sub.pending)
	return events
}
func (s *membershipStore) publishChannel(channel string, rescan bool) {
	var revision, last int64
	err := s.db.QueryRow("SELECT message_revision,COALESCE((SELECT MAX(message_id) FROM messages WHERE channel_id=?),0) FROM channels WHERE channel_id=?", channel, channel).Scan(&revision, &last)
	if err != nil {
		s.events.notify()
		return
	}
	s.events.publish(memberEvent{Type: "chat", ChannelID: channel, Revision: revision, Last: last, Rescan: rescan})
}

// Resolve identifiers before deletion; no user-supplied identity or channel metadata is broadcast.
func (s *membershipStore) mutationChannel(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 4 {
		return ""
	}
	if parts[2] == "channels" && len(parts) >= 5 && parts[4] == "messages" && validHexID(parts[3], 32) {
		return parts[3]
	}
	var channel string
	if parts[2] == "messages" {
		if id, err := strconv.ParseInt(parts[3], 10, 64); err == nil {
			s.db.QueryRow("SELECT channel_id FROM messages WHERE message_id=?", id).Scan(&channel)
		}
	}
	if parts[2] == "polls" {
		s.db.QueryRow("SELECT m.channel_id FROM polls p JOIN messages m ON m.message_id=p.message_id WHERE p.poll_id=?", parts[3]).Scan(&channel)
	}
	return channel
}
func (s *membershipStore) eventAccess(ctx context.Context, token, channel string) (memberAccess, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return memberAccess{}, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return access, err
	}
	if channel == "" {
		return access, nil
	}
	return access, memberTextChannelTx(ctx, tx, channel)
}
func headerToken(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}
func (a *membershipAPI) chatEvents(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("id")
	if channel != "" && !validHexID(channel, 32) {
		memberFail(w, memberError(400, "INVALID_CHANNEL"))
		return
	}
	token := memberBearer(r)
	access, err := a.store.eventAccess(r.Context(), token, channel)
	if err != nil {
		memberFail(w, err)
		return
	}
	key, err := base64.StdEncoding.Strict().DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	if err != nil || len(key) != 16 || r.Header.Get("Sec-WebSocket-Version") != "13" || !headerToken(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Origin") != "" || r.URL.RawQuery != "" {
		memberFail(w, memberError(400, "INVALID_WEBSOCKET"))
		return
	}
	changes, unsubscribe, ok := a.store.events.subscribeChannel(access.DeviceID, channel)
	if !ok {
		memberFail(w, memberError(429, "RATE_LIMIT"))
		return
	}
	defer unsubscribe()
	hj, ok := w.(http.Hijacker)
	if !ok {
		memberFail(w, memberError(500, "SERVER_ERROR"))
		return
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	accept := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if _, err = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(accept[:]) + "\r\n\r\n"); err != nil {
		return
	}
	if rw.Flush() != nil {
		return
	}
	controls := make(chan wsControl, 4)
	done := make(chan struct{})
	go func() { defer close(done); readWSControls(conn, rw.Reader, controls) }()
	// Always invalidate on connect: covers writes during handshake and offline gaps.
	initial := []byte("changed")
	if channel == "" {
		a.store.events.mu.Lock()
		initial, _ = json.Marshal(memberEvent{Type: "resync", Sequence: a.store.events.sequence})
		a.store.events.mu.Unlock()
	}
	if writeWS(conn, 1, initial) != nil {
		return
	}
	awaitingPong := false
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-done:
			select {
			case c := <-controls:
				if c.op == 8 {
					writeWS(conn, 8, c.data)
				}
			default:
			}
			return
		case c := <-controls:
			if c.op == 8 {
				writeWS(conn, 8, c.data)
				return
			}
			if c.op == 10 && channel == "" && awaitingPong {
				awaitingPong = false
				if _, err = a.store.heartbeat(r.Context(), token); err != nil {
					writeWS(conn, 8, []byte{3, 240})
					return
				}
			}
			if c.op == 9 {
				if writeWS(conn, 10, c.data) != nil {
					return
				}
			}
		case <-changes:
			// One access check per bounded batch, including during a busy channel burst.
			timer := time.NewTimer(80 * time.Millisecond)
			select {
			case <-timer.C:
			case <-done:
				timer.Stop()
				return
			case <-r.Context().Done():
				timer.Stop()
				return
			}
			if _, err = a.store.eventAccess(r.Context(), token, channel); err != nil {
				writeWS(conn, 8, []byte{3, 240})
				return
			}
			events := a.store.events.drain(changes)
			for _, event := range events {
				payload := []byte("changed")
				if channel == "" {
					payload, _ = json.Marshal(event)
				}
				if writeWS(conn, 1, payload) != nil {
					return
				}
				if channel != "" {
					break
				}
			}
		case <-tick.C:
			if _, err = a.store.eventAccess(r.Context(), token, channel); err != nil {
				writeWS(conn, 8, []byte{3, 240})
				return
			}
			awaitingPong = true
			if writeWS(conn, 9, nil) != nil {
				return
			}
		}
	}
}

type wsControl struct {
	op   byte
	data []byte
}

// This subscription protocol accepts only masked, unfragmented control frames.
// Application messages are server-to-client invalidations, never client writes.
func readWSControls(conn net.Conn, r *bufio.Reader, out chan<- wsControl) {
	for {
		conn.SetReadDeadline(time.Now().Add(45 * time.Second))
		var h [2]byte
		if _, err := io.ReadFull(r, h[:]); err != nil {
			return
		}
		op := h[0] & 15
		n := int(h[1] & 127)
		if h[0]&240 != 128 || h[1]&128 == 0 || n > 125 || (op != 8 && op != 9 && op != 10) || op == 8 && n == 1 {
			return
		}
		var mask [4]byte
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(r, data); err != nil {
			return
		}
		for i := range data {
			data[i] ^= mask[i%4]
		}
		if op == 8 && n >= 2 {
			code := int(data[0])<<8 | int(data[1])
			if code < 1000 || code >= 5000 || code == 1004 || code == 1005 || code == 1006 || code == 1015 || code > 1014 && code < 3000 || !utf8.Valid(data[2:]) {
				return
			}
		}

		select {
		case out <- wsControl{op, data}:
		default:
			return
		}
		if op == 8 {
			return
		}
	}
}
func writeWS(conn net.Conn, op byte, data []byte) error {
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	header := []byte{128 | op, byte(len(data))}
	if len(data) > 125 {
		header = []byte{128 | op, 126, 0, 0}
		binary.BigEndian.PutUint16(header[2:], uint16(len(data)))
	}
	_, err := conn.Write(append(header, data...))
	return err
}

// Mutation handlers notify only after their transaction and successful response.
type eventResponse struct {
	http.ResponseWriter
	status int
}

func (w *eventResponse) WriteHeader(code int) { w.status = code; w.ResponseWriter.WriteHeader(code) }
func (w *eventResponse) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(p)
}
func eventMutation(path string) bool {
	if !strings.HasPrefix(path, "/api/v2/") || strings.HasSuffix(path, "/status") || strings.HasSuffix(path, "/heartbeat") || path == "/api/v2/activity" || path == "/api/v2/session" {
		return false
	}
	return true
}

func (a *membershipAPI) eventStatus(w http.ResponseWriter, r *http.Request) {
	if _, err := a.store.eventAccess(r.Context(), memberBearer(r), ""); err != nil {
		memberFail(w, err)
		return
	}
	a.store.events.mu.Lock()
	sequence := a.store.events.sequence
	a.store.events.mu.Unlock()
	respond(w, 200, map[string]uint64{"sequence": sequence})
}

// One server-wide expiry check, independent of subscriber count. Heartbeats
// update sessions; roster invalidation occurs only when the live count changes.
func (s *membershipStore) refreshPresenceEvents(ctx context.Context) {
	var count int64
	now := s.now().UnixMilli()
	if s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at>? AND last_seen_at>?", now, now-45000).Scan(&count) != nil {
		return
	}
	s.events.mu.Lock()
	changed := count != s.events.presence
	s.events.presence = count
	s.events.mu.Unlock()
	if changed {
		s.events.publish(memberEvent{Type: "state"})
	}
}
