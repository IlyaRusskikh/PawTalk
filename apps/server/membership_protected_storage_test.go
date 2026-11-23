package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedStorageQuotaPreservesArchiveAndPollPair(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(1_800_000_000, 0)
	server.now = func() time.Time { return now }
	channel := strings.Repeat("a", 32)
	store, initial, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Channels[channel] = state.Channels["private"]
		delete(state.Channels, "private")
	})
	commitPolicy := func(request access.PolicyDraft) access.PolicyProof {
		t.Helper()
		preview, err := server.previewProtectedPolicy(ctx, owner.Token, request)
		if err != nil {
			t.Fatal(err)
		}
		proof, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, preview))
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := commitPolicy(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	node, _ := exec.LookPath("node")
	secrets := make(map[string][]byte)
	epochKey := func(seed byte) string {
		secret := bytes.Repeat([]byte{seed}, 32)
		id := publicKeyID(secret)
		secrets[id] = secret
		return id
	}
	publishLive := func(seed byte) access.EpochRecord {
		t.Helper()
		epoch, packages := prepareTestEpoch(t, server, owner, 1, channel, epochKey(seed))
		if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
			t.Fatal(err)
		}
		return epoch
	}
	publishArchive := func(seed byte, sources ...access.EpochRecord) access.EpochRecord {
		t.Helper()
		task, err := server.claimProtectedRotation(ctx, owner.Token, channel, access.ArchiveEpoch)
		if err != nil {
			t.Fatal(err)
		}
		task.KeyID = epochKey(seed)
		var targets []access.ArchiveTarget
		for _, source := range sources {
			targets = append(targets, access.ArchiveTarget{Purpose: source.Purpose, Generation: source.Generation, KeyID: source.KeyID})
		}
		var sealed struct {
			Packages []access.EpochPackage
			Links    []access.ArchiveLink
			WrapKey  string
		}
		if node != "" {
			runProtectedStorageClient(t, node, map[string]any{
				"mode": "archive", "serverId": serverID, "task": task, "targets": targets, "secrets": secrets,
			}, &sealed)
		} else {
			for id := range task.Recipients {
				sealed.Packages = append(sealed.Packages, access.EpochPackage{RecipientID: id, Purpose: access.ArchiveEpoch,
					Ciphertext: bytes.Repeat([]byte{1}, access.EpochPackageSize)})
			}
			for _, target := range targets {
				sealed.Links = append(sealed.Links, access.ArchiveLink{ArchiveTarget: target,
					Ciphertext: bytes.Repeat([]byte{byte(target.Generation)}, access.ArchiveLinkSize)})
			}
			sealed.WrapKey = testRecipientKey(t, byte(10+task.Generation))
		}
		archive := task.EpochRecord
		archive.PackagesDigest, err = access.PackagesDigest(sealed.Packages)
		if err != nil {
			t.Fatal(err)
		}
		archive.ArchiveLinksDigest, err = access.ArchiveLinksDigest(sealed.Links)
		if err != nil {
			t.Fatal(err)
		}
		archive.ArchiveWrapKey = sealed.WrapKey
		archive = signTestEpoch(t, server, owner, 1, archive)
		if err := server.commitProtectedEpoch(ctx, owner.Token, archive, sealed.Packages, sealed.Links...); err != nil {
			t.Fatal(err)
		}
		return archive
	}
	firstLive := publishLive('a')
	author := access.Principal{ProfileID: owner.Access.EffectiveProfileID, DeviceID: owner.Access.DeviceID}
	const survivorText = "Readable archive history after quota cleanup"
	original := func(op byte, mutate func(*access.MessageAttempt)) (access.MessageAttempt, uint64) {
		t.Helper()
		packet := access.MessageAttempt{ChannelID: channel, KeyID: firstLive.KeyID, OperationID: fmt.Sprintf("%032x", op),
			Nonce: bytes.Repeat([]byte{op}, 12), Ciphertext: make([]byte, 17)}
		if mutate != nil {
			mutate(&packet)
		}
		if op == 4 && node != "" {
			runProtectedStorageClient(t, node, map[string]any{
				"mode": "text", "serverId": serverID, "author": author, "deviceSeed": newTestMemberSigner(1).device.Seed(),
				"packet": packet, "secret": secrets[firstLive.KeyID], "text": survivorText,
			}, &packet)
		} else {
			packet = signProtectedTestMessage(t, server, owner, 1, packet)
		}
		receipt, err := server.appendProtectedMessage(ctx, owner.Token, packet)
		if err != nil {
			t.Fatal(err)
		}
		return packet, receipt.Position
	}
	_, poll := original(2, func(packet *access.MessageAttempt) { packet.Poll = &access.MessagePoll{Duration: 3600, OptionCount: 2} })
	ownerSession := server.protectedSession(owner.Token)
	if err := store.ClosePoll(ctx, ownerSession, nil, channel, poll); err != nil {
		t.Fatal(err)
	}
	if err := store.PublishPollResult(ctx, channel, poll, false, signProtectedPollResult); err != nil {
		t.Fatal(err)
	}
	var result uint64
	if err := server.db.QueryRow(`SELECT position FROM protected_poll_results WHERE channel_id=? AND original_position=?`, channel, poll).Scan(&result); err != nil {
		t.Fatal(err)
	}
	file := access.MessageAttachment{ID: strings.Repeat("b", 32), Kind: "file"}
	if err := store.PutAttachmentBlock(ctx, ownerSession, channel, file, access.AttachmentBlock{
		Total: access.AttachmentBlockSize, Bytes: make([]byte, access.AttachmentBlockSize),
	}, nil); err != nil {
		t.Fatal(err)
	}
	pinnedAttempt, pinned := original(3, func(packet *access.MessageAttempt) { packet.Attachments = []access.MessageAttachment{file} })
	_, survivor := original(4, nil)
	for _, position := range []uint64{poll, result, pinned} {
		if err := store.SetMessagePin(ctx, ownerSession, channel, position, true, false); err != nil {
			t.Fatal(err)
		}
	}
	archiveOne := publishArchive('c', firstLive)
	fullReader := initial.Roles["reader"]
	initial.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.send"}}
	commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("5", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order}})
	emptyLive := publishLive('d')
	archiveTwo := publishArchive('e', archiveOne, emptyLive)
	initial.Roles["reader"] = fullReader
	commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("6", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order}})
	currentLive := publishLive('f')
	archiveHead := publishArchive('9', archiveTwo, currentLive)
	server.protectedBinding = strings.Repeat("c", 64)
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: strings.Repeat("d", 64),
		anchorDigest: anchor.Digest, challenges: make(map[string]int64)}
	login := func(member memberSession, seed byte) string {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest,
			server.protectedBinding, challenge.Nonce, member.Access.DeviceID)
		if err != nil {
			t.Fatal(err)
		}
		session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: member.Access.DeviceID, Nonce: challenge.Nonce,
			Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return session.Token
	}
	ownerToken, readerToken := login(owner, 1), login(reader, 2)
	room := httptest.NewTLSServer(runtime.handler())
	defer func() { room.Close() }()
	setLimit := func(limit int64) {
		room.Close()
		server.maxBytes = limit
		room = httptest.NewTLSServer(runtime.handler())
	}
	call := func(method, path, token string, body any, status int, out any) {
		t.Helper()
		var encoded []byte
		var err error
		if body != nil {
			encoded, err = json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
		}
		request, err := http.NewRequestWithContext(ctx, method, room.URL+path, bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := room.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != status {
			var details json.RawMessage
			_ = json.NewDecoder(response.Body).Decode(&details)
			t.Fatalf("%s %s: HTTP %d expected %d: %s", method, path, response.StatusCode, status, details)
		}
		if out != nil {
			if err := json.NewDecoder(response.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
	}
	storageUsed := func() int64 {
		t.Helper()
		tx, err := server.db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		used, err := memberStorageUsed(ctx, tx)
		if err != nil {
			t.Fatal(err)
		}
		return used
	}
	used := storageUsed()
	setLimit(1)
	path := "/api/v3/history/live/" + channel
	post := signProtectedTestMessage(t, server, reader, 2, access.MessageAttempt{ChannelID: channel, KeyID: currentLive.KeyID,
		OperationID: strings.Repeat("8", 32), Nonce: make([]byte, 12), Ciphertext: make([]byte, 17)})
	var failure struct{ Error struct{ Code string } }
	call(http.MethodPost, path, readerToken, post, http.StatusInsufficientStorage, &failure)
	if failure.Error.Code != "STORAGE_LIMIT" || storageUsed() != used {
		t.Fatalf("irreclaimable quota failed to roll back: %+v", failure)
	}
	var pins access.PinnedMessagesPage
	call(http.MethodGet, "/api/v3/history/pins/"+channel, ownerToken, nil, http.StatusOK, &pins)
	if len(pins.Items) != 3 {
		t.Fatalf("failed quota write removed pinned history: %+v", pins)
	}
	// The first small victim cannot free enough space. The large attached
	// message then frees pages while the still-readable history is retained.
	setLimit(used - 64*1024)
	var receipt access.MessageReceipt
	call(http.MethodPost, path, readerToken, post, http.StatusOK, &receipt)
	if receipt.Existing || receipt.Position != survivor+1 || storageUsed() > server.maxBytes {
		t.Fatalf("quota did not preserve exact retry/position and fit within budget: %+v", receipt)
	}
	call(http.MethodGet, "/api/v3/history/pins/"+channel, ownerToken, nil, http.StatusOK, &pins)
	if len(pins.Items) != 0 {
		t.Fatalf("pins prevented retention cleanup: %+v", pins)
	}
	var page access.LiveMessagePage
	call(http.MethodGet, path, readerToken, nil, http.StatusOK, &page)
	if len(page.Messages) != 2 || page.Messages[0].Position != survivor || page.Messages[0].Packet.KeyID != firstLive.KeyID ||
		page.Messages[1].Position != receipt.Position {
		t.Fatalf("retention left the poll/result or removed the survivor: %+v", page.Messages)
	}
	var chain []access.ArchiveLinkDelivery
	for _, archive := range []access.EpochRecord{archiveHead, archiveTwo, archiveOne} {
		var history access.ArchiveLinkDelivery
		call(http.MethodGet, "/api/v3/keys/archive/"+channel+"/links/"+archive.KeyID, readerToken, nil, http.StatusOK, &history)
		if digest, err := access.ArchiveLinksDigest(history.Links); err != nil || digest != archive.ArchiveLinksDigest ||
			history.Epoch.Record.KeyID != archive.KeyID {
			t.Fatalf("retention damaged archive traversal through an empty live generation: %v", err)
		}
		chain = append(chain, history)
	}
	t.Run("desktop opens surviving ciphertext through the archive", func(t *testing.T) {
		if node == "" {
			t.Skip("Node is not installed")
		}
		var head access.EpochPackageDelivery
		call(http.MethodGet, "/api/v3/keys/current/"+channel+"/archive", readerToken, nil, http.StatusOK, &head)
		var opened struct{}
		runProtectedStorageClient(t, node, map[string]any{
			"mode": "open", "serverId": serverID, "head": head, "history": chain,
			"signer":  map[string]string{"profileId": author.ProfileID, "deviceId": author.DeviceID, "key": testSigningKey(1)},
			"reader":  map[string]string{"id": reader.Access.DeviceID, "key": initial.KeyRecipients[reader.Access.DeviceID].PublicKey},
			"message": page.Messages[0], "text": survivorText,
		}, &opened)
	})
	call(http.MethodPost, path, ownerToken, pinnedAttempt, http.StatusOK, &receipt)
	if !receipt.Existing || receipt.Position != pinned {
		t.Fatalf("retention discarded the old anti-replay receipt: %+v", receipt)
	}
	revisionPath := fmt.Sprintf("/api/v3/history/revision/%s/%d", channel, survivor)
	var basis access.RevisionBasis
	call(http.MethodGet, revisionPath+"/basis", ownerToken, nil, http.StatusOK, &basis)
	if len(basis.Recipients) != 0 {
		t.Fatalf("fixture expected all revision recipients to use the archive: %+v", basis.Recipients)
	}
	var emptyRevisionPackages [37]byte
	emptyRevisionPackages[0] = 2 // Counted commitment tag, zero leaves, zero tree root.
	emptyRoot := publicKeyID(emptyRevisionPackages[:])
	edit := access.RevisionAttempt{RevisionExpectation: basis.RevisionExpectation, OperationID: strings.Repeat("7", 32),
		Packet: access.RevisionPacket{Nonce: make([]byte, 12), Ciphertext: make([]byte, 17),
			ArchivePackage: make([]byte, access.EpochPackageSize), RecipientDigest: emptyRoot}}
	frame, err := protectedRevisionFrame(serverID, access.Principal{ProfileID: owner.Access.EffectiveProfileID, DeviceID: owner.Access.DeviceID}, channel, basis, edit)
	if err != nil {
		t.Fatal(err)
	}
	edit.Packet.Signature = ed25519.Sign(newTestMemberSigner(1).device, frame)
	used = storageUsed()
	setLimit(1)
	call(http.MethodPut, revisionPath, ownerToken, edit, http.StatusInsufficientStorage, &failure)
	if failure.Error.Code != "STORAGE_LIMIT" || storageUsed() != used {
		t.Fatalf("owner revision was not rolled back at quota: %+v", failure)
	}
	call(http.MethodGet, path, ownerToken, nil, http.StatusOK, &page)
	if len(page.Messages) != 2 || page.Messages[0].Position != survivor || page.Messages[0].Revision != 0 {
		t.Fatalf("rejected edit deleted the original or leaked a revision: %+v", page.Messages)
	}
	setLimit(0)
	var applied access.RevisionReceipt
	call(http.MethodPut, revisionPath, ownerToken, edit, http.StatusOK, &applied)
	if applied.Existing || applied.Revision != basis.Revision {
		t.Fatalf("rolled-back edit did not leave its operation free to retry: %+v", applied)
	}
}
