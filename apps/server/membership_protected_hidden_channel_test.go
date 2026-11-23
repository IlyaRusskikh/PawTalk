package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedHiddenChannelReadContractTLS(t *testing.T) {
	const (
		hidden  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		visible = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		absent  = "cccccccccccccccccccccccccccccccc"
		label   = "Private channel label"
	)
	ctx := t.Context()
	server := testMembershipStore(t)
	var clock atomic.Int64
	clock.Store(10_000_000)
	server.now = func() time.Time { return time.UnixMilli(clock.Load()) }
	store, _, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "channel.edit", "message.send", "history.full"}}
		state.Channels = map[string]access.Channel{
			visible: {Kind: "text", NextPosition: 1, Settings: &access.ChannelSettings{Name: "Visible channel"}},
			hidden: {Kind: "text", NextPosition: 1, Settings: &access.ChannelSettings{Name: label},
				ACL: access.ACL{Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}}}},
		}
		state.ChannelOrder = []string{visible, hidden}
	})
	anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
	owner.Token, reader.Token = open(owner, 1), open(reader, 2)
	epoch, packages := prepareTestEpoch(t, server, owner, 1, hidden, strings.Repeat("d", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
		t.Fatal(err)
	}
	ownerSession := runtime.resolveSession(owner.Token)
	attachment := access.MessageAttachment{ID: strings.Repeat("e", 32), Kind: "file"}
	block := access.AttachmentBlock{Total: 17, Bytes: bytes.Repeat([]byte{1}, 17)}
	if err := store.PutAttachmentBlock(ctx, ownerSession, hidden, attachment, block, nil); err != nil {
		t.Fatal(err)
	}
	message := signProtectedTestMessage(t, server, owner, 1, access.MessageAttempt{
		ChannelID: hidden, KeyID: epoch.KeyID, OperationID: strings.Repeat("f", 32),
		Nonce: bytes.Repeat([]byte{2}, 12), Ciphertext: bytes.Repeat([]byte{3}, 17),
		Attachments: []access.MessageAttachment{attachment}, Poll: &access.MessagePoll{OptionCount: 2, Duration: 3600},
	})
	receipt, err := server.appendProtectedMessage(ctx, owner.Token, message)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetMessagePin(ctx, ownerSession, hidden, receipt.Position, true, false); err != nil {
		t.Fatal(err)
	}
	position := fmt.Sprint(receipt.Position)
	wantDenied := []byte(`{"error":{"code":"PROTECTED_ACCESS_DENIED","message":"PROTECTED_ACCESS_DENIED"}}`)
	paths := []string{
		"/policy/channel-order/%s",
		"/history/window/%s",
		"/history/imported/%s",
		"/history/live/%s",
		"/history/poll/%s/" + position,
		"/history/pins/%s",
		"/history/live-attachments/%s/" + position + "/" + attachment.ID + "?offset=0",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			call(http.MethodGet, "/api/v3"+fmt.Sprintf(path, hidden), owner.Token, nil, http.StatusOK)
			for _, channel := range []string{hidden, absent} {
				body := call(http.MethodGet, "/api/v3"+fmt.Sprintf(path, channel), reader.Token, nil, http.StatusForbidden)
				if !bytes.Equal(bytes.TrimSpace(body), wantDenied) {
					t.Fatalf("unexpected error response: %s", body)
				}
			}
		})
	}
	for _, channel := range []string{hidden, absent} {
		change := access.ChannelLayoutChange{OperationID: strings.Repeat("8", 32), Source: visible, Anchor: channel,
			After: true, Revision: anchor.Draft.Revision, PolicyHead: anchor.Digest, OrderBasis: strings.Repeat("9", 64)}
		readerPrincipal := access.Principal{ProfileID: reader.Access.EffectiveProfileID, DeviceID: reader.Access.DeviceID}
		frame, err := access.ChannelLayoutFrame(runtime.serverID, readerPrincipal, change)
		if err != nil {
			t.Fatal(err)
		}
		change.Signature = ed25519.Sign(newTestMemberSigner(2).device, frame)
		input, err := json.Marshal(change)
		if err != nil {
			t.Fatal(err)
		}
		body := call(http.MethodPost, "/api/v3/policy/channel-order", reader.Token, input, http.StatusForbidden)
		if !bytes.Equal(bytes.TrimSpace(body), wantDenied) {
			t.Fatalf("unexpected reorder error response: %s", body)
		}
	}
	state := call(http.MethodGet, "/api/v3/state", reader.Token, nil, http.StatusOK)
	if !bytes.Contains(state, []byte(visible)) || bytes.Contains(state, []byte(hidden)) || bytes.Contains(state, []byte(label)) {
		t.Fatalf("channel directory returned the wrong scope: %s", state)
	}
	// Let the owner's rotation priority expire, so queue filtering depends on channel access.
	clock.Add(15_000)
	for _, session := range []memberSession{owner, reader} {
		body := call(http.MethodGet, "/api/v3/keys/rotations", session.Token, nil, http.StatusOK)
		var tasks []access.PendingRotation
		if err := json.Unmarshal(body, &tasks); err != nil || len(tasks) == 0 {
			t.Fatalf("expected a nonempty rotation queue: %s (%v)", body, err)
		}
		foundHidden, foundVisible := false, false
		for _, task := range tasks {
			foundHidden = foundHidden || task.ChannelID == hidden
			foundVisible = foundVisible || task.ChannelID == visible
		}
		if !foundVisible || foundHidden != (session.Token == owner.Token) {
			t.Fatalf("rotation queue has the wrong scope: %s", body)
		}
	}
}
