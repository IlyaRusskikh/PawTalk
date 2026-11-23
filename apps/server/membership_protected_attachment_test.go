package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"os/exec"
	"slices"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedAttachmentMessageFrameMatchesClient(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js unavailable")
	}
	cmd := exec.Command(node, "-e", `
		const crypto = require('node:crypto');
		const text = require('../client/windows/electron/protected-live-text.cjs');
		const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
		const key = publicKey.export({format: 'der', type: 'spki'}).subarray(-32);
		const hash = value => crypto.createHash('sha256').update(value).digest('hex');
		const author = { ProfileID: 'a'.repeat(64), DeviceID: hash(key) };
		const secret = Buffer.alloc(32, 1);
		const server = 'b'.repeat(32);
		const packet = text.sealProtectedText(secret, server, author, { ChannelID: 'c'.repeat(32),
			OperationID: 'd'.repeat(32), KeyID: hash(secret), ...text.protectedReplyFields('d'.repeat(32), 1),
			Attachments: [{ id: '1'.repeat(32), kind: 'file' }, { id: '2'.repeat(32), kind: 'voice' }] }, 'hello', privateKey);
		if (text.openProtectedText(secret, server, author, packet, key.toString('hex')) !== 'hello') process.exit(1);
		process.stdout.write(JSON.stringify({ key: key.toString('base64'), author, server, packet }));
	`)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("sign with Electron module: %v\n%s", err, out)
	}
	var vector struct {
		Key    []byte
		Author access.Principal
		Server string
		Packet access.MessageAttempt
	}
	if err := json.Unmarshal(out, &vector); err != nil {
		t.Fatal(err)
	}
	verify := func(packet access.MessageAttempt) bool {
		t.Helper()
		frame, err := protectedMessageFrame(vector.Server, vector.Author, packet)
		if err != nil {
			t.Fatal(err)
		}
		return ed25519.Verify(vector.Key, frame, packet.Signature)
	}
	if !verify(vector.Packet) {
		t.Fatal("Go rejected Electron attachment signature")
	}
	vector.Packet.Attachments[0], vector.Packet.Attachments[1] = vector.Packet.Attachments[1], vector.Packet.Attachments[0]
	if verify(vector.Packet) {
		t.Fatal("signature accepted reordered attachments")
	}
}

func TestProtectedAttachmentTransactions(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	store, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		role := state.Roles["reader"]
		role.Grants = append(role.Grants, "message.attach")
		state.Roles["reader"] = role
		state.Channels["other"] = access.Channel{Kind: "text", NextPosition: 1}
	})
	commit := func(draft access.PolicyDraft) {
		t.Helper()
		preview, err := server.previewProtectedPolicy(ctx, owner.Token, draft)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, preview)); err != nil {
			t.Fatal(err)
		}
	}
	commit(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	const channel = "private"
	key := strings.Repeat("a", 64)
	epoch, packages := prepareTestEpoch(t, server, owner, 1, channel, key)
	if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
		t.Fatal(err)
	}
	ref := access.MessageAttachment{ID: strings.Repeat("1", 32), Kind: "file"}
	block := access.AttachmentBlock{Total: access.AttachmentBlockSize + 17, Bytes: make([]byte, access.AttachmentBlockSize)}
	last := access.AttachmentBlock{Offset: access.AttachmentBlockSize, Total: block.Total, Bytes: bytes.Repeat([]byte{42}, 17)}
	put := func(token, target string, ref access.MessageAttachment, block access.AttachmentBlock) error {
		return store.PutAttachmentBlock(ctx, server.protectedSession(token), target, ref, block, server.checkProtectedAttachmentStorage)
	}
	appendMessage := func(session memberSession, seed byte, nonce byte) (access.MessageReceipt, error) {
		packet := access.MessageAttempt{ChannelID: channel, OperationID: strings.Repeat(string('a'+rune(nonce)), 32), KeyID: key,
			Nonce: bytes.Repeat([]byte{nonce}, 12), Ciphertext: make([]byte, 17), Attachments: []access.MessageAttachment{ref}}
		return server.appendProtectedMessage(ctx, session.Token, signProtectedTestMessage(t, server, session, seed, packet))
	}
	read := func(token, target string, position uint64, offset int) (access.AttachmentBlock, error) {
		var result access.AttachmentBlock
		err := store.DispatchAttachmentBlock(ctx, server.protectedSession(token), target, position, ref.ID, offset, func(block access.AttachmentBlock) error {
			result = block
			return nil
		})
		return result, err
	}
	voice := access.MessageAttachment{ID: ref.ID, Kind: "voice"}
	if err := put(reader.Token, channel, voice, block); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("file grant authorized voice message: %v", err)
	}
	for range 2 {
		if err := put(reader.Token, channel, ref, block); err != nil {
			t.Fatal(err)
		}
	}
	if err := put(owner.Token, channel, ref, last); !errors.Is(err, access.ErrAttachmentConflict) {
		t.Fatalf("foreign uploader: %v", err)
	}
	if err := put(reader.Token, "other", ref, last); !errors.Is(err, access.ErrAttachmentConflict) {
		t.Fatalf("foreign channel: %v", err)
	}
	if _, err := appendMessage(reader, 2, 1); !errors.Is(err, access.ErrAttachmentConflict) {
		t.Fatalf("incomplete attachment published: %v", err)
	}
	if _, err := read(reader.Token, channel, 1, 0); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("pending attachment was readable: %v", err)
	}
	if err := put(reader.Token, channel, ref, last); err != nil {
		t.Fatal(err)
	}
	if _, err := appendMessage(owner, 1, 2); !errors.Is(err, access.ErrAttachmentConflict) {
		t.Fatalf("owner published another device's attachment: %v", err)
	}
	if receipt, err := appendMessage(reader, 2, 1); err != nil || receipt.Position != 1 {
		t.Fatalf("append receipt=%+v error=%v", receipt, err)
	}
	if receipt, err := appendMessage(reader, 2, 1); err != nil || !receipt.Existing || receipt.Position != 1 {
		t.Fatalf("retry receipt=%+v error=%v", receipt, err)
	}
	if _, err := appendMessage(reader, 2, 3); !errors.Is(err, access.ErrAttachmentConflict) {
		t.Fatalf("rebound published attachment: %v", err)
	}
	if err := store.DispatchLiveMessages(ctx, server.protectedSession(owner.Token), channel, 0, 1, nil, false, func(page access.LiveMessagePage) error {
		if len(page.Messages) != 1 || !slices.Equal(page.Messages[0].Packet.Attachments, []access.MessageAttachment{ref}) {
			t.Fatalf("history attachments: %+v", page.Messages)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if result, err := read(owner.Token, channel, 1, last.Offset); err != nil || result.Total != block.Total || !bytes.Equal(result.Bytes, last.Bytes) {
		t.Fatalf("download total=%d bytes=%x error=%v", result.Total, result.Bytes, err)
	}
	if err := store.DeleteMessage(ctx, server.protectedSession(owner.Token), nil, channel, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := read(reader.Token, channel, 1, 0); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("deleted attachment was readable: %v", err)
	}
	if err := put(reader.Token, channel, ref, block); !errors.Is(err, access.ErrAttachmentConflict) {
		t.Fatalf("deleted attachment ID was reused: %v", err)
	}
	ref.ID = strings.Repeat("2", 32)
	server.maxBytes = 1
	var quotaError *membershipError
	if err := put(reader.Token, channel, ref, block); !errors.As(err, &quotaError) || quotaError.Code != "STORAGE_LIMIT" {
		t.Fatalf("storage quota: %v", err)
	}
	if err := server.db.QueryRow(`SELECT id FROM protected_attachments WHERE id=?`, ref.ID).Scan(new(string)); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("quota failure left staged data: %v", err)
	}
	server.maxBytes = 0
	if err := put(reader.Token, channel, ref, block); err != nil {
		t.Fatal(err)
	}
	role := state.Roles["reader"]
	role.Grants = slices.DeleteFunc(role.Grants, func(grant string) bool { return grant == "message.attach" })
	state.Roles["reader"] = role
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("2", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	if err := put(reader.Token, channel, ref, last); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("upload continued after grant revoked: %v", err)
	}
	if _, err := appendMessage(reader, 2, 4); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("publish authorized after grant revoked: %v", err)
	}
}
