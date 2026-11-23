package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedRuntimeWebSocketFiltersQueuedEventsAfterRevoke(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	const private = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const public = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	const voice = "cccccccccccccccccccccccccccccccc"
	const hiddenVoice = "dddddddddddddddddddddddddddddddd"
	store, _, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Channels = map[string]access.Channel{
			private: {Kind: "text", NextPosition: 1}, public: {Kind: "text", NextPosition: 1},
			voice: {Kind: "voice", NextPosition: 1},
			hiddenVoice: {Kind: "voice", NextPosition: 1, ACL: access.ACL{
				Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}},
			}},
		}
	})
	_, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.ChannelACLProjectionVersion)
	owner.Token = open(owner, 1)
	reader.Token = open(reader, 2)
	for _, channel := range []string{private, public} {
		epoch, packages := prepareTestEpoch(t, server, owner, 1, channel, channel+channel)
		if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
			t.Fatal(err)
		}
	}
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	config := room.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	conn, err := tls.Dial("tcp", room.Listener.Addr().String(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(8 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintf(conn, "GET /api/v3/events?after=8&voice=1&composer=1 HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", room.Listener.Addr(), reader.Token); err != nil {
		t.Fatal(err)
	}
	wire := bufio.NewReader(conn)
	response, err := http.ReadResponse(wire, nil)
	if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("handshake: %v %v", response, err)
	}
	read := func() (byte, []byte) {
		t.Helper()
		var header [2]byte
		if _, err := io.ReadFull(wire, header[:]); err != nil {
			t.Fatal(err)
		}
		length := uint16(header[1])
		if length == 126 {
			if err := binary.Read(wire, binary.BigEndian, &length); err != nil {
				t.Fatal(err)
			}
		} else if length > 125 {
			t.Fatalf("unexpected frame header %x", header)
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(wire, payload); err != nil {
			t.Fatal(err)
		}
		return header[0] & 15, payload
	}
	check := func(kind string, sequence uint64, channel string) {
		t.Helper()
		op, raw := read()
		var found protectedEventFrame
		if err := json.Unmarshal(raw, &found); err != nil || op != 1 || found != (protectedEventFrame{Type: kind, Sequence: sequence, ChannelID: channel}) {
			t.Fatalf("event %d %s, want %s %d %s: %v", op, raw, kind, sequence, channel, err)
		}
	}
	post := func(channel, operation string, nonce byte) {
		t.Helper()
		attempt := signProtectedTestMessage(t, server, owner, 1, access.MessageAttempt{
			ChannelID: channel, OperationID: strings.Repeat(operation, 32), KeyID: channel + channel,
			Nonce: bytes.Repeat([]byte{nonce}, 12), Ciphertext: bytes.Repeat([]byte{nonce}, 17),
		})
		raw, err := json.Marshal(attempt)
		if err != nil {
			t.Fatal(err)
		}
		call(http.MethodPost, "/api/v3/history/live/"+channel, owner.Token, raw, http.StatusOK)
	}
	check("resync", 9, "")
	post(private, "2", 2)
	check("chat", 10, private)

	// Park two real queue entries without waking the reader. The successful
	// signed HTTP revoke wakes the same production subscription after commit.
	runtime.events.mu.Lock()
	for _, sub := range runtime.events.subscribers {
		sub.pending["queued-content"] = memberEvent{Type: "chat", ChannelID: private, Last: 1}
		sub.pending["queued-metadata"] = memberEvent{Type: "state", ChannelID: private}
	}
	runtime.events.mu.Unlock()
	acl := access.ACL{Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}}}
	draft, err := store.PreviewPolicy(ctx, runtime.resolveSession(owner.Token), access.PolicyDraft{
		Action: access.UpdateChannelACL, OperationID: strings.Repeat("3", 32),
		ResourceChange:        &access.PolicyResourceChange{ID: private, ACL: &acl},
		TextProjectionVersion: access.ChannelACLProjectionVersion, TextProjectionSeed: strings.Repeat("bb", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(signTestPolicyDraft(t, server, owner, 1, draft))
	if err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, "/api/v3/policy/commit", owner.Token, raw, http.StatusOK)
	check("state", 11, "")
	post(public, "4", 4)
	check("chat", 12, public)
	runtime.publishProtectedVoice(hiddenVoice)
	runtime.publishProtectedVoice(voice)
	check("voice", 13, voice)
	composer := func(channel, token, activity string, code int) {
		t.Helper()
		call(http.MethodPut, "/api/v3/composer/"+channel, token, []byte(`{"activity":"`+activity+`"}`), code)
	}
	composer(private, reader.Token, "typing", http.StatusForbidden)
	composer(private, owner.Token, "typing", http.StatusOK)
	for i, activity := range []string{"typing", "recording", "idle"} {
		composer(public, owner.Token, activity, http.StatusOK)
		op, raw := read()
		want := protectedEventFrame{Type: "composer", Sequence: uint64(14 + i), ChannelID: public,
			Activity: activity, ProfileID: owner.Access.EffectiveProfileID}
		var received protectedEventFrame
		if err := json.Unmarshal(raw, &received); err != nil || op != 1 || received != want {
			t.Fatalf("unexpected composer event %d %s: %v", op, raw, err)
		}
	}
	state := call(http.MethodGet, "/api/v3/state", reader.Token, nil, http.StatusOK)
	if bytes.Contains(state, []byte(private)) || !bytes.Contains(state, []byte(public)) {
		t.Fatalf("polling projection after revoke: %s", state)
	}
	call(http.MethodGet, "/api/v3/history/live/"+private, reader.Token, nil, http.StatusForbidden)
	if _, err := server.db.ExecContext(ctx, "DELETE FROM protected_runtime_sessions WHERE device_id=?", reader.Access.DeviceID); err != nil {
		t.Fatal(err)
	}
	post(public, "5", 5)
	if op, _ := read(); op != 8 {
		t.Fatalf("revoked session received opcode %d", op)
	}
}
