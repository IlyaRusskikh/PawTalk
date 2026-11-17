package main

import (
	"bufio"
	"context"
	"crypto/sha1" // RFC 6455 handshake, not an identity primitive.
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Coalesced invalidations carry no plaintext, ciphertext or user identities.
// HTTP reads remain the authenticated source of history and poll data.
type chatEvents struct {
	mu          sync.Mutex
	subscribers map[chan struct{}]string
}

func (e *chatEvents) subscribe(device string) (chan struct{}, func(), bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.subscribers) >= 1024 {
		return nil, nil, false
	}
	count := 0
	for _, id := range e.subscribers {
		if id == device {
			count++
		}
	}
	if count >= 2 {
		return nil, nil, false
	}
	if e.subscribers == nil {
		e.subscribers = make(map[chan struct{}]string)
	}
	ch := make(chan struct{}, 1)
	e.subscribers[ch] = device
	return ch, func() { e.mu.Lock(); delete(e.subscribers, ch); e.mu.Unlock() }, true
}
func (e *chatEvents) notify() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for ch := range e.subscribers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
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
	if !validHexID(channel, 32) {
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
	changes, unsubscribe, ok := a.store.events.subscribe(access.DeviceID)
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
	if writeWS(conn, 1, []byte("changed")) != nil {
		return
	}
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
			if c.op == 9 {
				if writeWS(conn, 10, c.data) != nil {
					return
				}
			}
		case <-changes:
			if _, err = a.store.eventAccess(r.Context(), token, channel); err != nil {
				writeWS(conn, 8, []byte{3, 240})
				return
			}
			if writeWS(conn, 1, []byte("changed")) != nil {
				return
			}
		case <-tick.C:
			if _, err = a.store.eventAccess(r.Context(), token, channel); err != nil {
				writeWS(conn, 8, []byte{3, 240})
				return
			}
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
		if op == 10 {
			continue
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
	_, err := conn.Write(append([]byte{128 | op, byte(len(data))}, data...))
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
func chatMutation(path string) bool {
	return strings.Contains(path, "/messages") || strings.Contains(path, "/polls") || strings.Contains(path, "/channels") || strings.Contains(path, "/members") || strings.Contains(path, "/bans") || strings.HasSuffix(path, "/leave") || strings.Contains(path, "/devices/")
}
