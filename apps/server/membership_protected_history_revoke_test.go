package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedHTTPRevocationOrdersHistoryAndDerivedReads(t *testing.T) {
	ctx, stop := context.WithTimeout(context.Background(), 15*time.Second)
	defer stop()
	server, err := openMembershipStore(filepath.Join(t.TempDir(), "scoped-history.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer server.db.Close()
	// Let reads reach SQLite while the revocation holds its policy transaction.
	// A single-connection pool would serialize them even without the read lock.
	server.db.SetMaxOpenConns(8)
	const private = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const public = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	store, _, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Channels = map[string]access.Channel{
			private: {Kind: "text", NextPosition: 1}, public: {Kind: "text", NextPosition: 1},
		}
	})
	_, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.ChannelACLProjectionVersion)
	owner.Token, reader.Token = open(owner, 1), open(reader, 2)
	publish := func(marker string) access.EpochRecord {
		t.Helper()
		epoch, packages := prepareTestEpoch(t, server, owner, 1, private, strings.Repeat(marker, 64))
		if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
			t.Fatal(err)
		}
		return epoch
	}
	firstEpoch := publish("1")
	ref := access.MessageAttachment{ID: strings.Repeat("c", 32), Kind: "file"}
	ownerSession := runtime.resolveSession(owner.Token)
	for _, block := range []access.AttachmentBlock{
		{Offset: 0, Total: access.AttachmentBlockSize + 1, Bytes: bytes.Repeat([]byte{7}, access.AttachmentBlockSize)},
		{Offset: access.AttachmentBlockSize, Total: access.AttachmentBlockSize + 1, Bytes: []byte{8}},
	} {
		if err := store.PutAttachmentBlock(ctx, ownerSession, private, ref, block, nil); err != nil {
			t.Fatal(err)
		}
	}
	appendMessage := func(request access.MessageAttempt) access.MessageReceipt {
		t.Helper()
		packet := signProtectedTestMessage(t, server, owner, 1, request)
		written, err := server.appendProtectedMessage(ctx, owner.Token, packet)
		if err != nil {
			t.Fatal(err)
		}
		return written
	}
	original := appendMessage(access.MessageAttempt{ChannelID: private, KeyID: firstEpoch.KeyID,
		OperationID: strings.Repeat("2", 32), Nonce: bytes.Repeat([]byte{2}, 12), Ciphertext: bytes.Repeat([]byte{2}, 17),
		Attachments: []access.MessageAttachment{ref}})
	if err := store.SetMessagePin(ctx, ownerSession, private, original.Position, true, false); err != nil {
		t.Fatal(err)
	}
	historyURL := "/api/v3/history/live/" + private
	pinsURL := "/api/v3/history/pins/" + private
	windowURL := "/api/v3/history/window/" + private
	blockURL := fmt.Sprintf("/api/v3/history/live-attachments/%s/%d/%s?offset=", private, original.Position, ref.ID)
	var firstBlock access.AttachmentBlock
	raw := call(http.MethodGet, blockURL+"0", reader.Token, nil, http.StatusOK)
	if json.Unmarshal(raw, &firstBlock) != nil || len(firstBlock.Bytes) != access.AttachmentBlockSize {
		t.Fatal("live attachment continuation requires a prior authorized block")
	}
	var pins access.PinnedMessagesPage
	if raw := call(http.MethodGet, pinsURL, reader.Token, nil, http.StatusOK); json.Unmarshal(raw, &pins) != nil || len(pins.Items) != 1 {
		t.Fatalf("original pin was not visible before revoke: %s", raw)
	}
	signACL := func(operation, grant string) access.PolicyDraft {
		t.Helper()
		acl := access.ACL{Roles: map[string]access.Overwrite{"reader": {Deny: []string{grant}}}}
		draft, err := store.PreviewPolicy(ctx, ownerSession, access.PolicyDraft{
			Action: access.UpdateChannelACL, OperationID: strings.Repeat(operation, 32),
			ResourceChange:        &access.PolicyResourceChange{ID: private, ACL: &acl},
			TextProjectionVersion: access.ChannelACLProjectionVersion, TextProjectionSeed: strings.Repeat(operation, 64),
		})
		if err != nil {
			t.Fatal(err)
		}
		return signTestPolicyDraft(t, server, owner, 1, draft)
	}
	revoke := signACL("3", access.ChannelView)
	entered := make(chan struct{}, 5)
	handler := runtime.handler()
	room := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		handler.ServeHTTP(w, r)
	}))
	defer room.Close()
	signatureVerified, release := make(chan struct{}), make(chan struct{})
	revokeDone := make(chan error, 1)
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	go func() {
		_, err := store.CommitPolicy(ctx, ownerSession, func(ctx context.Context, query access.SessionQuery,
			principal access.Principal, draft access.PolicyDraft) error {
			if err := verifyProtectedPolicyDraft(ctx, query, principal, draft); err != nil {
				return err
			}
			if draft.OperationID != revoke.OperationID {
				return nil
			}
			close(signatureVerified)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}, revoke)
		revokeDone <- err
	}()
	select {
	case <-signatureVerified:
	case err := <-revokeDone:
		t.Fatalf("revoke did not acquire the policy transaction: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	paths := []string{historyURL, pinsURL, windowURL, blockURL + fmt.Sprint(access.AttachmentBlockSize), "/api/v3/state"}
	type result struct {
		path   string
		status int
		body   []byte
		err    error
	}
	results := make(chan result, len(paths))
	for _, path := range paths {
		go func() {
			r, err := http.NewRequestWithContext(ctx, http.MethodGet, room.URL+path, nil)
			if err != nil {
				results <- result{path: path, err: err}
				return
			}
			r.Header.Set("Authorization", "Bearer "+reader.Token)
			response, err := room.Client().Do(r)
			if err != nil {
				results <- result{path: path, err: err}
				return
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			results <- result{path: path, status: response.StatusCode, body: body, err: err}
		}()
	}
	for range paths {
		select {
		case <-entered:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	select {
	case got := <-results:
		t.Fatalf("%s escaped the in-flight revoke transaction: %d, %v", got.path, got.status, got.err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-revokeDone; err != nil {
		t.Fatalf("could not commit signed revoke: %v", err)
	}
	for range paths {
		got := <-results
		if got.err != nil || bytes.Contains(got.body, []byte(private)) || bytes.Contains(got.body, []byte(ref.ID)) {
			t.Fatalf("%s revealed revoked metadata or failed delivery: %s, %v", got.path, got.body, got.err)
		}
		if got.path == "/api/v3/state" {
			if got.status != http.StatusOK || !bytes.Contains(got.body, []byte(public)) {
				t.Fatalf("state polling lost the remaining channel: %d %s", got.status, got.body)
			}
		} else if got.status != http.StatusForbidden || !bytes.Contains(got.body, []byte("PROTECTED_ACCESS_DENIED")) {
			t.Fatalf("%s returned history after revoke: %d %s", got.path, got.status, got.body)
		}
	}
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, signACL("4", "history.full")); err != nil {
		t.Fatal(err)
	}
	nextEpoch := publish("5")
	salt, operation := strings.Repeat("e", 64), strings.Repeat("6", 32)
	replyDigest := publicKeyID([]byte(fmt.Sprintf("pawtalk-protected-reply-v1:%s:%d:%s", operation, original.Position, salt)))
	reply := appendMessage(access.MessageAttempt{ChannelID: private, KeyID: nextEpoch.KeyID, OperationID: operation,
		Nonce: bytes.Repeat([]byte{6}, 12), Ciphertext: bytes.Repeat([]byte{6}, 17),
		Reply: &access.MessageReply{Position: original.Position, Salt: salt}, ReplyDigest: replyDigest})
	var page access.LiveMessagePage
	raw = call(http.MethodGet, historyURL, reader.Token, nil, http.StatusOK)
	if json.Unmarshal(raw, &page) != nil || page.First != reply.Position || len(page.Messages) != 1 ||
		page.Messages[0].Packet.Reply != nil || page.Messages[0].Packet.ReplyDigest != replyDigest ||
		bytes.Contains(raw, []byte(salt)) || bytes.Contains(raw, []byte(ref.ID)) {
		t.Fatalf("readmission exposed a historical reply target or lost the new reply: %s", raw)
	}
	if raw := call(http.MethodGet, pinsURL, reader.Token, nil, http.StatusOK); json.Unmarshal(raw, &pins) != nil || len(pins.Items) != 0 {
		t.Fatalf("earlier admission pin returned after readmission: %s", raw)
	}
	call(http.MethodGet, blockURL+fmt.Sprint(access.AttachmentBlockSize), reader.Token, nil, http.StatusForbidden)
}
