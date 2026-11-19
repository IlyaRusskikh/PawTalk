package main

import (
	"bufio"
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

func TestChecklistPermissionsEditAndCascade(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	signer := newTestMemberSigner(2)
	activateTestMember(t, s, signer, "member")
	other := loginTestMember(t, s, signer)
	var channel string
	if err := s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel); err != nil {
		t.Fatal(err)
	}
	input := testMessage('b')
	item := strings.Repeat("c", 32)
	input.Checklist = &memberChecklistDefinition{Items: []string{item}, Everyone: false}
	id, err := s.postMessage(ctx, owner.Token, channel, input)
	if err != nil {
		t.Fatal(err)
	}
	api := membershipAPI{store: s}
	call := func(token, item, receipt string) int {
		r := httptest.NewRequest("PUT", fmt.Sprintf("/api/v2/messages/%d/checklist", id), strings.NewReader(fmt.Sprintf(`{"item":%q,"checked":true,"requestId":%q}`, item, receipt)))
		r.SetPathValue("id", fmt.Sprint(id))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		api.checklist(w, r)
		return w.Code
	}
	if status := call(other.Token, item, strings.Repeat("d", 32)); status != 403 {
		t.Fatalf("non-author checked: %d", status)
	}
	if status := call(owner.Token, item, strings.Repeat("e", 32)); status != 200 {
		t.Fatalf("author check: %d", status)
	}
	edit := testMessage('f')
	edit.Checklist = &memberChecklistDefinition{Items: []string{item, strings.Repeat("a", 32)}, Everyone: true}
	if err = s.editMessage(ctx, other.Token, id, edit); err == nil {
		t.Fatal("non-author edited checklist")
	}
	if err = s.editMessage(ctx, owner.Token, id, edit); err != nil {
		t.Fatal(err)
	}
	var checked string
	if err = s.db.QueryRow("SELECT checked FROM checklists WHERE message_id=?", id).Scan(&checked); err != nil || !strings.Contains(checked, item) {
		t.Fatalf("edit lost checks: %s %v", checked, err)
	}
	if status := call(other.Token, strings.Repeat("a", 32), strings.Repeat("1", 32)); status != 200 {
		t.Fatalf("shared check: %d", status)
	}
	if status := call(other.Token, strings.Repeat("0", 32), strings.Repeat("2", 32)); status != 409 {
		t.Fatalf("unknown item: %d", status)
	}
	if err = s.deleteMessage(ctx, owner.Token, id, strings.Repeat("3", 32)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.db.QueryRow("SELECT COUNT(*) FROM checklists").Scan(&count); err != nil || count != 0 {
		t.Fatalf("orphan checklist: %d %v", count, err)
	}
}

func TestChecklistCommitReachesOtherMemberOverWebSocket(t *testing.T) {
	s := testMembershipStore(t)
	ctx := context.Background()
	owner := bootstrapTestServer(t, s, newTestMemberSigner(1))
	signer := newTestMemberSigner(2)
	activateTestMember(t, s, signer, "member")
	other := loginTestMember(t, s, signer)
	var channel string
	if err := s.db.QueryRow("SELECT channel_id FROM channels WHERE kind='text'").Scan(&channel); err != nil {
		t.Fatal(err)
	}
	input := testMessage('b')
	item := strings.Repeat("c", 32)
	input.Checklist = &memberChecklistDefinition{Items: []string{item}, Everyone: true}
	id, err := s.postMessage(ctx, owner.Token, channel, input)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(newMembershipHandler(s, config{}))
	defer server.Close()
	connection, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	connection.SetDeadline(time.Now().Add(8 * time.Second))
	fmt.Fprintf(connection, "GET /api/v2/events/messages HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", server.Listener.Addr(), other.Token)
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, nil)
	if err != nil || response.StatusCode != 101 {
		t.Fatal("upgrade", err)
	}
	read := func() memberEvent {
		t.Helper()
		var header [2]byte
		if _, err = io.ReadFull(reader, header[:]); err != nil {
			t.Fatal(err)
		}
		length := int(header[1] & 127)
		if length == 126 {
			var extra [2]byte
			if _, err = io.ReadFull(reader, extra[:]); err != nil {
				t.Fatal(err)
			}
			length = int(binary.BigEndian.Uint16(extra[:]))
		}
		if length > 60000 {
			t.Fatal("unbounded frame")
		}
		raw := make([]byte, length)
		if _, err = io.ReadFull(reader, raw); err != nil {
			t.Fatal(err)
		}
		var event memberEvent
		if err = json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		return event
	}
	read() // Initial stream resync; the next frame must be the committed toggle.
	request, _ := http.NewRequest("PUT", fmt.Sprintf("%s/api/v2/messages/%d/checklist", server.URL, id), strings.NewReader(fmt.Sprintf(`{"item":%q,"checked":true,"requestId":%q}`, item, strings.Repeat("d", 32))))
	request.Header.Set("Authorization", "Bearer "+owner.Token)
	request.Header.Set("Content-Type", "application/json")
	ack, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer ack.Body.Close()
	if ack.StatusCode != 200 {
		t.Fatal("toggle status", ack.StatusCode)
	}
	event := read()
	if event.Type != "chat" || !event.Delivery || event.Previous >= event.Revision || len(event.Checklists) != 1 {
		t.Fatalf("missing committed checklist payload: %+v", event)
	}
	update := event.Checklists[0]
	if update.MessageID != id || update.Revision != event.Revision || !update.Checked[item] {
		t.Fatalf("incorrect checklist snapshot: %+v", update)
	}
	if len(event.Messages) != 1 || event.Messages[0].Ciphertext != input.Ciphertext {
		t.Fatal("toggle rewrote encrypted content")
	}
}
