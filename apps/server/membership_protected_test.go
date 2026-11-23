package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedPolicyProofsVerifyInClient(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	server := testMembershipStore(t)
	store, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Categories = map[string]access.ACL{"private": {}, "public<&>": {}}
		channel := state.Channels["private"]
		channel.CategoryID, channel.Synchronized = "private", true
		state.Channels["private"] = channel
	})
	preview := func(session memberSession, input access.PolicyDraft) access.PolicyDraft {
		t.Helper()
		draft, err := server.previewProtectedPolicy(ctx, session.Token, input)
		if err != nil {
			t.Fatal(err)
		}
		return draft
	}
	commit := func(session memberSession, seed byte, input access.PolicyDraft) {
		t.Helper()
		draft := preview(session, input)
		if _, err := server.commitProtectedPolicy(ctx, session.Token, signTestPolicyDraft(t, server, session, seed, draft)); err != nil {
			t.Fatal(err)
		}
	}
	page := func(after int64) access.PolicyPage {
		t.Helper()
		result, err := store.PolicyProofPage(ctx, after)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	commit(owner, 1, access.PolicyDraft{Action: access.AnchorPolicy, OperationID: fmt.Sprintf("%032x", 1)})
	initial := page(0)
	// An additional device can hold a valid legacy session for the owner.
	// The protected policy still has to authorize that exact device.
	outside := newTestMemberSigner(3)
	outsideIdentity := activateTestMember(t, server, outside, "member")
	if _, err := server.db.ExecContext(ctx, "INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)",
		outsideIdentity.ProfileID, owner.Access.EffectiveProfileID, server.now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.ExecContext(ctx, "UPDATE memberships SET state='linked' WHERE profile_id=?", outsideIdentity.ProfileID); err != nil {
		t.Fatal(err)
	}
	outsideSession := loginTestMember(t, server, outside)
	if outsideSession.Access.EffectiveProfileID != owner.Access.EffectiveProfileID {
		t.Fatal("additional test device did not receive owner's legacy identity")
	}
	if _, err := server.previewProtectedPolicy(ctx, outsideSession.Token, access.PolicyDraft{
		Action: access.EnrollRecipientKey, OperationID: fmt.Sprintf("%032x", 4), PublicKey: testRecipientKey(t, 33),
	}); !errors.Is(err, access.Inactive) {
		t.Fatalf("unlisted owner device accessed protected policy: %v", err)
	}
	state.Roles["roles<&>"] = access.Role{}
	commit(owner, 1, access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", 2),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: []string{"reader", "roles<&>"}}})
	commit(reader, 2, access.PolicyDraft{Action: access.RevokeRecipientKey, OperationID: fmt.Sprintf("%032x", 3)})
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	enrollment := preview(owner, access.PolicyDraft{Action: access.EnrollPolicyDevice, OperationID: fmt.Sprintf("%032x", 4),
		DeviceChange: &access.PolicyDeviceChange{DeviceID: outsideIdentity.DeviceID, PublicKey: testSigningKey(3)}})
	author := access.Principal{ProfileID: owner.Access.EffectiveProfileID, DeviceID: owner.Access.DeviceID}
	stale := enrollment
	stale.OperationID = fmt.Sprintf("%032x", 99)
	consentFrame, err := protectedDeviceConsentFrame(serverID, author, stale, *enrollment.DeviceChange)
	if err != nil {
		t.Fatal(err)
	}
	enrollment.DeviceChange.Consent = ed25519.Sign(outside.device, consentFrame)
	var consentError *membershipError
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, enrollment)); !errors.As(err, &consentError) ||
		consentError.Code != "INVALID_DEVICE_CONSENT" {
		t.Fatalf("accepted consent for a different operation: %v", err)
	}
	consentFrame, err = protectedDeviceConsentFrame(serverID, author, enrollment, *enrollment.DeviceChange)
	if err != nil {
		t.Fatal(err)
	}
	enrollment.DeviceChange.Consent = ed25519.Sign(outside.device, consentFrame)
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, enrollment)); err != nil {
		t.Fatal(err)
	}
	recipientKey := testRecipientKey(t, 33)
	commit(outsideSession, 3, access.PolicyDraft{Action: access.EnrollRecipientKey, OperationID: fmt.Sprintf("%032x", 5), PublicKey: recipientKey})
	live, packages := prepareTestEpoch(t, server, owner, 1, "private", strings.Repeat("a", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, live, packages); err != nil {
		t.Fatal(err)
	}
	revoke := access.PolicyDraft{Action: access.RevokePolicyDevice, OperationID: fmt.Sprintf("%032x", 6),
		DeviceChange: &access.PolicyDeviceChange{DeviceID: outsideIdentity.DeviceID}}
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, revoke); !errors.Is(err, access.InvalidAction) {
		t.Fatalf("device from a different profile could revoke: %v", err)
	}
	commit(outsideSession, 3, revoke)
	if _, err := server.claimProtectedRotation(ctx, outsideSession.Token, "private", access.LiveEpoch); !errors.Is(err, access.Inactive) {
		t.Fatalf("device retained protected access after self-revocation: %v", err)
	}
	task, err := server.claimProtectedRotation(ctx, owner.Token, "private", access.LiveEpoch)
	if err != nil || task.PreviousDigest == "" {
		t.Fatalf("device revocation did not queue next epoch: %+v, %v", task, err)
	}
	if _, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.EnrollPolicyDevice, OperationID: fmt.Sprintf("%032x", 7), DeviceChange: enrollment.DeviceChange,
	}); !errors.Is(err, access.InvalidAction) {
		t.Fatalf("revoked signing device could be re-enrolled: %v", err)
	}
	applied, _, err := store.Snapshot(ctx)
	if err != nil || !applied.PolicyDevices[outsideIdentity.DeviceID].Revoked ||
		applied.KeyRecipients[outsideIdentity.DeviceID].PublicKey != "" || !applied.RetiredRecipientKeys[recipientKey] {
		t.Fatalf("device and recipient were not revoked in the same revision: %v", err)
	}
	deny := access.ACL{Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}}}
	request := access.PolicyDraft{Action: access.UpdateChannelACL, OperationID: fmt.Sprintf("%032x", 7),
		ResourceChange: &access.PolicyResourceChange{ID: "private", ACL: &deny}}
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, request); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("reader accessed ACL mutation: %v", err)
	}
	staleACL := signTestPolicyDraft(t, server, owner, 1, preview(owner, request))
	clear := access.ACL{}
	commit(owner, 1, access.PolicyDraft{Action: access.UpdateCategoryACL, OperationID: fmt.Sprintf("%032x", 8),
		ResourceChange: &access.PolicyResourceChange{ID: "private", ACL: &clear}})
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, staleACL); !errors.Is(err, access.ErrPolicyConflict) {
		t.Fatalf("stale signed ACL preview committed: %v", err)
	}
	commit(owner, 1, request)
	commit(owner, 1, access.PolicyDraft{Action: access.MovePolicyChannel, OperationID: fmt.Sprintf("%032x", 9),
		ResourceChange: &access.PolicyResourceChange{ID: "private", CategoryID: "public<&>", Mode: access.PreserveAccess}})
	commit(owner, 1, access.PolicyDraft{Action: access.UpdateCategoryACL, OperationID: fmt.Sprintf("%032x", 10),
		ResourceChange: &access.PolicyResourceChange{ID: "public<&>", ACL: &clear}})
	applied, _, err = store.Snapshot(ctx)
	if err != nil || applied.CanDeliver(reader.Access.EffectiveProfileID, "private", 0) {
		t.Fatalf("moving a custom channel disclosed it: %v", err)
	}
	post, err := server.appendProtectedMessage(ctx, owner.Token, signProtectedTestMessage(t, server, owner, 1, access.MessageAttempt{
		ChannelID: "private", OperationID: fmt.Sprintf("%032x", 50), KeyID: live.KeyID,
		Ciphertext: make([]byte, 17), Nonce: make([]byte, 12),
	}))
	if err != nil {
		t.Fatal(err)
	}
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.send"}}
	commit(owner, 1, access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", 12),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: []string{"reader", "roles<&>"}}})
	commit(owner, 1, access.PolicyDraft{Action: access.SyncChannelACL, OperationID: fmt.Sprintf("%032x", 11),
		ResourceChange: &access.PolicyResourceChange{ID: "private"}})
	applied, revision, err := store.Snapshot(ctx)
	if err != nil || !applied.CanDeliver(reader.Access.EffectiveProfileID, "private", 0) {
		t.Fatalf("explicit resync did not readmit reader: %v", err)
	}
	profile := reader.Access.EffectiveProfileID
	if applied.CanDeliver(profile, "private", post.Position) || applied.Admissions["private"][profile].FirstPosition != post.Position+1 {
		t.Fatal("resync admitted the limited reader to messages from an earlier interval")
	}
	category, source, copyID, visible := "mixed<&>", fmt.Sprintf("%032x", 201), fmt.Sprintf("%032x", 202), fmt.Sprintf("%032x", 203)
	applyResource := func(action string, operation int, change access.PolicyResourceChange) {
		t.Helper()
		commit(owner, 1, access.PolicyDraft{Action: action, OperationID: fmt.Sprintf("%032x", operation), ResourceChange: &change})
	}
	applyResource(access.CreatePolicyCategory, 13, access.PolicyResourceChange{ID: category})
	textDefinition := access.ChannelDefinition{Kind: "text", Settings: access.ChannelSettings{
		Name: "Закрытый чат", Description: "Только для владельца <&>", SlowmodeSeconds: 30,
	}}
	applyResource(access.CreatePolicyChannel, 14, access.PolicyResourceChange{ID: source, CategoryID: category, Channel: &textDefinition, ACL: &deny})
	channelEpoch, channelPackages := prepareTestEpoch(t, server, owner, 1, source, strings.Repeat("c", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, channelEpoch, channelPackages); err != nil {
		t.Fatal(err)
	}
	if _, err := server.appendProtectedMessage(ctx, owner.Token, signProtectedTestMessage(t, server, owner, 1, access.MessageAttempt{
		ChannelID: source, OperationID: fmt.Sprintf("%032x", 51), KeyID: channelEpoch.KeyID,
		Ciphertext: make([]byte, 17), Nonce: make([]byte, 12),
	})); err != nil {
		t.Fatal(err)
	}
	applyResource(access.CopyPolicyChannel, 15, access.PolicyResourceChange{ID: copyID, SourceID: source})
	newTask, err := server.claimProtectedRotation(ctx, owner.Token, copyID, access.LiveEpoch)
	if err != nil || newTask.Generation != 1 || newTask.PreviousDigest != "" || len(newTask.Recipients) != 1 {
		t.Fatalf("copy inherited key state or changed readers: %+v, %v", newTask, err)
	}
	applied, _, err = store.Snapshot(ctx)
	clone := applied.Channels[copyID]
	if err != nil || clone.Settings == nil || *clone.Settings != textDefinition.Settings || clone.NextPosition != 1 ||
		applied.CanDeliver(profile, copyID, 0) || applied.CanDeliver(owner.Access.EffectiveProfileID, copyID, 1) {
		t.Fatalf("copy did not preserve settings, privacy and independent history: %+v, %v", clone, err)
	}
	voiceDefinition := access.ChannelDefinition{Kind: "voice", Settings: access.ChannelSettings{Name: "Voice", VoiceCapacity: 3}}
	applyResource(access.CreatePolicyChannel, 16, access.PolicyResourceChange{ID: visible, CategoryID: category, Channel: &voiceDefinition})
	applyResource(access.EditPolicyChannel, 27, access.PolicyResourceChange{ID: visible, Settings: &access.ChannelSettings{
		Name: "Voice", Description: "Updated", VoiceCapacity: 4,
	}})
	applyResource(access.ChangeVoiceMute, 28, access.PolicyResourceChange{ID: visible, TargetProfileID: profile})
	applyResource(access.ChangeVoiceDeafen, 29, access.PolicyResourceChange{ID: visible, TargetProfileID: profile})
	applyResource(access.ChangeVoiceDeafen, 30, access.PolicyResourceChange{ID: visible, TargetProfileID: profile, Lift: true})
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.send", "channel.delete", "channel.create"}}
	commit(owner, 1, access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", 17),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: []string{"reader", "roles<&>"}}})
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, access.PolicyDraft{Action: access.DeletePolicyCategory,
		OperationID: fmt.Sprintf("%032x", 18), ResourceChange: &access.PolicyResourceChange{ID: category, Mode: access.DeleteChildren}}); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("deleting the category bypassed a closed child: %v", err)
	}
	applyResource(access.DeletePolicyCategory, 18, access.PolicyResourceChange{ID: category, Mode: access.KeepChildren})
	applyResource(access.DeletePolicyChannel, 19, access.PolicyResourceChange{ID: copyID})
	if _, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{Action: access.CopyPolicyChannel,
		OperationID: fmt.Sprintf("%032x", 20), ResourceChange: &access.PolicyResourceChange{ID: copyID, SourceID: source}}); !errors.Is(err, access.InvalidPolicy) {
		t.Fatalf("retired ID could be reused: %v", err)
	}
	for n, id := range []string{source, visible} {
		applyResource(access.DeletePolicyChannel, 21+n, access.PolicyResourceChange{ID: id})
	}
	temporaryCategory, firstChild := "reader-private-draft", fmt.Sprintf("%032x", 204)
	commit(reader, 2, access.PolicyDraft{Action: access.CreatePolicyCategory, OperationID: fmt.Sprintf("%032x", 23),
		ResourceChange: &access.PolicyResourceChange{ID: temporaryCategory}})
	commit(reader, 2, access.PolicyDraft{Action: access.CreatePolicyChannel, OperationID: fmt.Sprintf("%032x", 24),
		ResourceChange: &access.PolicyResourceChange{ID: firstChild, CategoryID: temporaryCategory, Channel: &voiceDefinition}})
	applyResource(access.DeletePolicyCategory, 25, access.PolicyResourceChange{ID: temporaryCategory, Mode: access.DeleteChildren})
	applyResource(access.DeletePolicyCategory, 26, access.PolicyResourceChange{ID: "public<&>", Mode: access.DeleteChildren})
	applied, revision, err = store.Snapshot(ctx)
	if err != nil || len(applied.Channels) != 0 || len(applied.Admissions) != 0 || len(applied.EpochWindows) != 0 ||
		!applied.RetiredChannels[source] || applied.CanDeliver(owner.Access.EffectiveProfileID, source, 1) {
		t.Fatalf("deletion retained active channels, or failed to retire identity: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"initial": initial, "latest": page(1), "current": page(revision),
		"trust": map[string]any{"serverId": serverID, "anchorDigest": initial.HeadDigest,
			"ownerProfileId": owner.Access.EffectiveProfileID, "ownerDeviceId": owner.Access.DeviceID}})
	if err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../client/windows/scripts/protected-policy-integration.mjs")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, node, script)
	hideWindow(command)
	command.Stdin = bytes.NewReader(payload)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("client proof verification: %v\n%s", err, output)
	}
	t.Log(string(output))
}

func TestProtectedSlowmodeAcrossLinkedDevicesAndRestart(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(20000, 0)
	clock := func() time.Time { return now }
	path := filepath.Join(t.TempDir(), "room.sqlite")
	server, err := openMembershipDatabase(path, clock)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { server.db.Close() }()
	linked := newTestMemberSigner(3)
	var second memberSession
	_, initial, owner, first := protectedTestStateWith(t, server, func(state *access.State) {
		reader := newTestMemberSigner(2)
		profile := publicKeyID(reader.root.Public().(ed25519.PublicKey))
		identity := activateTestMember(t, server, linked, "member")
		if _, err := server.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)",
			identity.ProfileID, profile, now.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if _, err := server.db.Exec("UPDATE memberships SET state='linked' WHERE profile_id=?", identity.ProfileID); err != nil {
			t.Fatal(err)
		}
		second = loginTestMember(t, server, linked)
		state.PolicyDevices[identity.DeviceID] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.KeyRecipients[identity.DeviceID] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 33)}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "history.full", "message.send", "channel.edit"}}
	})
	commit := func(session memberSession, seed byte, draft access.PolicyDraft) {
		t.Helper()
		preview, err := server.previewProtectedPolicy(ctx, session.Token, draft)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := server.commitProtectedPolicy(ctx, session.Token, signTestPolicyDraft(t, server, session, seed, preview)); err != nil {
			t.Fatal(err)
		}
	}
	commit(owner, 1, access.PolicyDraft{Action: access.AnchorPolicy, OperationID: fmt.Sprintf("%032x", 1)})
	settings := access.ChannelSettings{Name: "Room", SlowmodeSeconds: 2}
	edit := access.PolicyDraft{Action: access.EditPolicyChannel, OperationID: fmt.Sprintf("%032x", 2),
		ResourceChange: &access.PolicyResourceChange{ID: "private", Settings: &settings}}
	commit(first, 2, edit)
	if _, err := server.previewProtectedPolicy(ctx, first.Token, access.PolicyDraft{Action: access.UpdateChannelACL,
		OperationID: fmt.Sprintf("%032x", 3), ResourceChange: &access.PolicyResourceChange{ID: "private", ACL: &access.ACL{}}}); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("settings editor could also edit the ACL: %v", err)
	}
	live, packages := prepareTestEpoch(t, server, owner, 1, "private", strings.Repeat("c", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, live, packages); err != nil {
		t.Fatal(err)
	}
	newAttempt := func(session memberSession, seed, op byte) access.MessageAttempt {
		t.Helper()
		return signProtectedTestMessage(t, server, session, seed, access.MessageAttempt{
			ChannelID: "private", KeyID: live.KeyID, OperationID: fmt.Sprintf("%032x", op),
			Ciphertext: make([]byte, 17), Nonce: bytes.Repeat([]byte{op}, 12),
		})
	}
	type sender struct {
		session memberSession
		attempt access.MessageAttempt
	}
	senders := []sender{{first, newAttempt(first, 2, 1)}, {second, newAttempt(second, 3, 2)}}
	results := make([]error, len(senders))
	start := make(chan struct{})
	var sent sync.WaitGroup
	for i, candidate := range senders {
		sent.Add(1)
		go func() {
			defer sent.Done()
			<-start
			_, results[i] = server.appendProtectedMessage(ctx, candidate.session.Token, candidate.attempt)
		}()
	}
	close(start)
	sent.Wait()
	retryAt := now.Add(2 * time.Second).UnixMilli()
	winner, loser := -1, -1
	for i, result := range results {
		var wait access.SlowmodeWait
		switch {
		case result == nil:
			winner = i
		case errors.As(result, &wait) && wait.RetryAt == retryAt:
			loser = i
		default:
			t.Fatalf("linked send failed with wrong outcome: %v", result)
		}
	}
	if winner < 0 || loser < 0 {
		t.Fatalf("linked devices did not share one slowmode slot: %v", results)
	}
	if err := server.db.Close(); err != nil {
		t.Fatal(err)
	}
	// API 2 startup refuses this schema. Reopen its SQLite file for the internal protected adapter.
	source := (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(path), "/"),
		RawQuery: "_txlock=immediate&_pragma=busy_timeout(5000)"}).String()
	db, err := sql.Open("sqlite", source)
	if err != nil {
		t.Fatal(err)
	}
	server = &membershipStore{db: db, now: clock}
	now = time.UnixMilli(retryAt - 1)
	blocked := senders[loser]
	var wait access.SlowmodeWait
	if _, err := server.appendProtectedMessage(ctx, blocked.session.Token, blocked.attempt); !errors.As(err, &wait) || wait.RetryAt != retryAt {
		t.Fatalf("slowmode window was lost after reopen: %v", err)
	}
	accepted := senders[winner]
	if receipt, err := server.appendProtectedMessage(ctx, accepted.session.Token, accepted.attempt); err != nil || !receipt.Existing || receipt.Position != 1 {
		t.Fatalf("retry consumed a new slowmode slot: %+v, %v", receipt, err)
	}
	now = time.UnixMilli(retryAt)
	if receipt, err := server.appendProtectedMessage(ctx, blocked.session.Token, blocked.attempt); err != nil || receipt.Position != 2 {
		t.Fatalf("retry at exact deadline failed: %+v, %v", receipt, err)
	}
	initial.Roles["reader"] = access.Role{Grants: append(initial.Roles["reader"].Grants, "message.slowmode.bypass")}
	commit(owner, 1, access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", 4),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order}})
	for op := byte(10); op < 16; op++ {
		attempt := newAttempt(blocked.session, byte(loser+2), op)
		_, err := server.appendProtectedMessage(ctx, blocked.session.Token, attempt)
		if op < 14 && err != nil || op >= 14 && !errors.Is(err, access.ErrMessageRateLimit) {
			t.Fatalf("bypass changed the technical limit at operation %d: %v", op, err)
		}
	}
}

func TestAPI2RefusesDatabaseWithProtectedPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "room.sqlite")
	server, err := openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer server.db.Close()
	protectedTestState(t, server)
	if err := server.db.Close(); err != nil {
		t.Fatal(err)
	}
	opened, err := openMembershipStore(path)
	if opened != nil {
		opened.db.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "API 2 startup refused") {
		t.Fatalf("wrong startup result: %v", err)
	}
}

func protectedTestState(t *testing.T, server *membershipStore) (*access.Store, access.State, memberSession, memberSession) {
	t.Helper()
	return protectedTestStateWith(t, server, func(*access.State) {})
}

func protectedTestStateWith(t *testing.T, server *membershipStore, configure func(*access.State)) (*access.Store, access.State, memberSession, memberSession) {
	t.Helper()
	owner := bootstrapTestServer(t, server, newTestMemberSigner(1))
	member := newTestMemberSigner(2)
	activateTestMember(t, server, member, "member")
	reader := loginTestMember(t, server, member)
	state := access.State{
		RoleSnapshot: access.RoleSnapshot{
			Policy: access.Policy{Owner: owner.Access.EffectiveProfileID, Order: []string{"reader"}, Roles: map[string]access.Role{
				access.Everyone: {},
				"reader":        {Grants: []string{access.ChannelView, "message.send", "history.full"}},
			}},
			Members: map[string]access.Subject{
				owner.Access.EffectiveProfileID:  {ID: owner.Access.EffectiveProfileID, Active: true},
				reader.Access.EffectiveProfileID: {ID: reader.Access.EffectiveProfileID, Active: true, Roles: []string{"reader"}},
			},
		},
		Channels: map[string]access.Channel{"private": {Kind: "text", NextPosition: 1}},
		PolicyDevices: map[string]access.PolicyDevice{
			owner.Access.DeviceID:  {ProfileID: owner.Access.EffectiveProfileID, PublicKey: testSigningKey(1)},
			reader.Access.DeviceID: {ProfileID: reader.Access.EffectiveProfileID, PublicKey: testSigningKey(2)},
		},
		KeyRecipients: map[string]access.KeyRecipient{
			owner.Access.DeviceID:  {ProfileID: owner.Access.EffectiveProfileID, Kind: "device", PublicKey: testRecipientKey(t, 11)},
			reader.Access.DeviceID: {ProfileID: reader.Access.EffectiveProfileID, Kind: "device", PublicKey: testRecipientKey(t, 22)},
		},
	}
	configure(&state)
	store := access.NewStoreWithClock(server.db, server.now)
	if err := store.Initialize(context.Background(), state); err != nil {
		t.Fatal(err)
	}
	return store, state, owner, reader
}

func testSigningKey(seed byte) string {
	return hex.EncodeToString(newTestMemberSigner(seed).device.Public().(ed25519.PublicKey))
}

func testRecipientKey(t *testing.T, value byte) string {
	t.Helper()
	key, err := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{value}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(key.PublicKey().Bytes())
}

func signTestPolicyDraft(t *testing.T, server *membershipStore, signer memberSession, seed byte, draft access.PolicyDraft) access.PolicyDraft {
	t.Helper()
	var id string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&id); err != nil {
		t.Fatal(err)
	}
	frame, err := protectedPolicyFrame(id, access.Principal{ProfileID: signer.Access.EffectiveProfileID, DeviceID: signer.Access.DeviceID}, draft)
	if err != nil {
		t.Fatal(err)
	}
	draft.Signature = ed25519.Sign(newTestMemberSigner(seed).device, frame)
	return draft
}

func TestProtectedSignedRecipientLifecycle(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(10000, 0)
	server.now = func() time.Time { return now }
	store, original, owner, reader := protectedTestState(t, server)
	preview := func(session memberSession, action string, id int, key string) access.PolicyDraft {
		t.Helper()
		draft, err := server.previewProtectedPolicy(ctx, session.Token, access.PolicyDraft{Action: action, OperationID: fmt.Sprintf("%032x", id), PublicKey: key})
		if err != nil {
			t.Fatal(err)
		}
		return draft
	}
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32)}); !errors.Is(err, access.ErrPolicyConflict) {
		t.Fatalf("member anchored policy: %v", err)
	}
	anchor := signTestPolicyDraft(t, server, owner, 1, preview(owner, access.AnchorPolicy, 1, ""))
	anchored, err := server.commitProtectedPolicy(ctx, owner.Token, anchor)
	if err != nil || anchored.Draft.Revision != 1 {
		t.Fatalf("anchor: %+v, %v", anchored, err)
	}
	if _, err := store.ApplyRoles(ctx, 1, owner.Access.EffectiveProfileID, original.Roles, original.Order, nil); !errors.Is(err, access.ErrPolicySignatureRequired) {
		t.Fatalf("unsigned mutation after anchor: %v", err)
	}
	key1, key2 := strings.Repeat("a", 64), strings.Repeat("b", 64)
	epoch, packages := prepareTestEpoch(t, server, owner, 1, "private", key1)
	if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
		t.Fatal(err)
	}
	readerRevoke := preview(reader, access.RevokeRecipientKey, 2, "")
	incorrect := signTestPolicyDraft(t, server, reader, 1, readerRevoke)
	var signatureError *membershipError
	if _, err := server.commitProtectedPolicy(ctx, reader.Token, incorrect); !errors.As(err, &signatureError) || signatureError.Code != "INVALID_POLICY_SIGNATURE" {
		t.Fatalf("wrong signature accepted: %v", err)
	}
	revoked, err := server.commitProtectedPolicy(ctx, reader.Token, signTestPolicyDraft(t, server, reader, 2, readerRevoke))
	if err != nil || revoked.Draft.PreviousDigest != anchored.Digest {
		t.Fatalf("revoke proof: %+v, %v", revoked, err)
	}
	post := access.MessageAttempt{ChannelID: "private", OperationID: strings.Repeat("5", 32), KeyID: key1,
		Ciphertext: make([]byte, 17), Nonce: make([]byte, 12)}
	if _, err := server.appendProtectedMessage(ctx, reader.Token, signProtectedTestMessage(t, server, reader, 2, post)); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("revoked key can still submit: %v", err)
	}
	oldKey := original.KeyRecipients[reader.Access.DeviceID].PublicKey
	enroll := access.PolicyDraft{Action: access.EnrollRecipientKey, OperationID: fmt.Sprintf("%032x", 3), PublicKey: oldKey}
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, enroll); !errors.Is(err, access.ErrRecipientKey) {
		t.Fatalf("retired key eligible to return: %v", err)
	}
	alias, err := hex.DecodeString(oldKey)
	if err != nil {
		t.Fatal(err)
	}
	alias[31] ^= 0x80
	enroll.PublicKey = hex.EncodeToString(alias)
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, enroll); !errors.Is(err, access.ErrRecipientKey) {
		t.Fatalf("non-canonical retired key alias enrolled: %v", err)
	}
	now = now.Add(5 * time.Second)
	rotation, packages := prepareTestEpoch(t, server, owner, 1, "private", key2)
	for _, item := range packages {
		if item.RecipientID == reader.Access.DeviceID {
			t.Fatal("revoked recipient present in new generation")
		}
	}
	if err := server.commitProtectedEpoch(ctx, owner.Token, rotation, packages); err != nil {
		t.Fatal(err)
	}
	stale := signTestPolicyDraft(t, server, owner, 1, preview(owner, access.RevokeRecipientKey, 4, ""))
	newKey := testRecipientKey(t, 33)
	registered, err := server.commitProtectedPolicy(ctx, reader.Token,
		signTestPolicyDraft(t, server, reader, 2, preview(reader, access.EnrollRecipientKey, 5, newKey)))
	if err != nil || registered.Draft.PreviousDigest != revoked.Digest || registered.Draft.Revision != 3 {
		t.Fatalf("registration proof: %+v, %v", registered, err)
	}
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, stale); !errors.Is(err, access.ErrPolicyConflict) {
		t.Fatalf("competing policy write accepted: %v", err)
	}
	var pending int
	if err := server.db.QueryRowContext(ctx, "SELECT count(*) FROM protected_rotation_tasks WHERE revision=3").Scan(&pending); err != nil || pending != 2 {
		t.Fatalf("registration and task not committed together: %d, %v", pending, err)
	}
	current, _, err := store.Snapshot(ctx)
	if err != nil || current.KeyRecipients[reader.Access.DeviceID].PublicKey != newKey {
		t.Fatalf("unexpected registry: %+v, %v", current.KeyRecipients, err)
	}
	post.KeyID = key2
	if _, err := server.appendProtectedMessage(ctx, reader.Token, signProtectedTestMessage(t, server, reader, 2, post)); !errors.Is(err, access.ErrEpochStale) {
		t.Fatalf("new key sent before receiving a package for its registration: %v", err)
	}
	post.KeyID = key1
	if _, err := server.appendProtectedMessage(ctx, reader.Token, signProtectedTestMessage(t, server, reader, 2, post)); !errors.Is(err, access.ErrEpochStale) {
		t.Fatalf("new registration inherited a retired key's grace package: %v", err)
	}
	roleRequest := access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: fmt.Sprintf("%032x", 6),
		RoleUpdate: &access.RolePolicyUpdate{Roles: original.Roles, Order: original.Order,
			Assignments: map[string][]string{reader.Access.EffectiveProfileID: nil}}}
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, roleRequest); err == nil {
		t.Fatal("unauthorized signed role change preview")
	}
	roleDraft, err := server.previewProtectedPolicy(ctx, owner.Token, roleRequest)
	if err != nil {
		t.Fatal(err)
	}
	roles, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, roleDraft))
	if err != nil || roles.Draft.PreviousDigest != registered.Digest || roles.Draft.Revision != 4 {
		t.Fatalf("signed role mutation not on chain: %+v, %v", roles, err)
	}
	current, _, err = store.Snapshot(ctx)
	if err != nil || current.CanDeliver(reader.Access.EffectiveProfileID, "private", 0) {
		t.Fatalf("signed role change failed to revoke channel access: %v", err)
	}
	delete(current.KeyRecipients, reader.Access.DeviceID)
	tampered, err := json.Marshal(current)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.ExecContext(ctx, "UPDATE protected_policy SET snapshot=? WHERE id=1", tampered); err != nil {
		t.Fatal(err)
	}
	if _, err := server.claimProtectedRotation(ctx, owner.Token, "private", access.LiveEpoch); !errors.Is(err, access.ErrPolicyConflict) {
		t.Fatalf("unsigned policy snapshot change accepted: %v", err)
	}
}

func signProtectedTestMessage(t *testing.T, server *membershipStore, session memberSession, seed byte, attempt access.MessageAttempt) access.MessageAttempt {
	t.Helper()
	var id string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&id); err != nil {
		t.Fatal(err)
	}
	principal := access.Principal{ProfileID: session.Access.EffectiveProfileID, DeviceID: session.Access.DeviceID}
	frame, err := protectedMessageFrame(id, principal, attempt)
	if err != nil {
		t.Fatal(err)
	}
	attempt.Signature = ed25519.Sign(newTestMemberSigner(seed).device, frame)
	return attempt
}

func prepareTestEpoch(t *testing.T, server *membershipStore, signer memberSession, seed byte, channel, keyID string) (access.EpochRecord, []access.EpochPackage) {
	t.Helper()
	return prepareTestEpochForPurpose(t, server, signer, seed, channel, keyID, access.LiveEpoch)
}

func prepareTestEpochForPurpose(t *testing.T, server *membershipStore, signer memberSession, seed byte, channel, keyID, purpose string) (access.EpochRecord, []access.EpochPackage) {
	t.Helper()
	task, err := server.claimProtectedRotation(context.Background(), signer.Token, channel, purpose)
	if err != nil {
		t.Fatal(err)
	}
	var packages []access.EpochPackage
	for id := range task.Recipients {
		packages = append(packages, access.EpochPackage{RecipientID: id, Purpose: purpose, Ciphertext: bytes.Repeat([]byte{1}, access.EpochPackageSize)})
	}
	record := task.EpochRecord
	record.KeyID = keyID
	record.PackagesDigest, err = access.PackagesDigest(packages)
	if err != nil {
		t.Fatal(err)
	}
	return signTestEpoch(t, server, signer, seed, record), packages
}

func signTestEpoch(t *testing.T, server *membershipStore, signer memberSession, seed byte, record access.EpochRecord) access.EpochRecord {
	t.Helper()
	var id string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&id); err != nil {
		t.Fatal(err)
	}
	frame, err := protectedEpochFrame(id, access.Principal{DeviceID: signer.Access.DeviceID, ProfileID: signer.Access.EffectiveProfileID}, record)
	if err != nil {
		t.Fatal(err)
	}
	record.Signature = ed25519.Sign(newTestMemberSigner(seed).device, frame)
	return record
}

func TestProtectedMessageSessionPositionAndRetries(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	store, state, owner, reader := protectedTestState(t, server)
	attempt := access.MessageAttempt{
		ChannelID: "private", OperationID: strings.Repeat("1", 32), KeyID: strings.Repeat("a", 64),
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64),
	}
	appendAs := func(token string, candidate access.MessageAttempt) (access.MessageReceipt, error) {
		return server.appendProtectedMessage(ctx, token, candidate)
	}
	if _, err := appendAs(reader.Token, signProtectedTestMessage(t, server, reader, 2, attempt)); !errors.Is(err, access.ErrEpochStale) {
		t.Fatalf("accepted write before first epoch: %v", err)
	}
	genesis, packages := prepareTestEpoch(t, server, owner, 1, attempt.ChannelID, attempt.KeyID)
	if err := server.commitProtectedEpoch(ctx, owner.Token, genesis, packages); err != nil {
		t.Fatal(err)
	}
	invalid := attempt
	invalid.KeyID = strings.Repeat("b", 64)
	if _, err := appendAs(reader.Token, signProtectedTestMessage(t, server, reader, 2, invalid)); !errors.Is(err, access.ErrEpochStale) {
		t.Fatalf("verifier rejection: %v", err)
	}
	attempt = signProtectedTestMessage(t, server, reader, 2, attempt)
	tampered := attempt
	tampered.Ciphertext = bytes.Repeat([]byte{1}, 17)
	var signatureError *membershipError
	if _, err := appendAs(reader.Token, tampered); !errors.As(err, &signatureError) || signatureError.Code != "INVALID_MESSAGE_SIGNATURE" {
		t.Fatalf("tampered envelope rejected incorrectly: %v", err)
	}
	first, err := appendAs(reader.Token, attempt)
	if err != nil || first.Position != 1 || first.Existing {
		t.Fatalf("first append: %+v %v", first, err)
	}
	invalid.Nonce = bytes.Repeat([]byte{1}, 12)
	retry, err := appendAs(reader.Token, invalid)
	if err != nil || retry.Position != first.Position || !retry.Existing {
		t.Fatalf("re-encrypted retry: %+v %v", retry, err)
	}
	second := attempt
	second.OperationID = strings.Repeat("2", 32)
	second = signProtectedTestMessage(t, server, reader, 2, second)
	if _, err := appendAs(reader.Token, second); !errors.Is(err, access.ErrNonceReuse) {
		t.Fatalf("new operation reused nonce: %v", err)
	}
	second.Nonce = invalid.Nonce
	second = signProtectedTestMessage(t, server, reader, 2, second)
	if receipt, err := appendAs(reader.Token, second); err != nil || receipt.Position != 2 {
		t.Fatalf("rejected attempts consumed position: %+v %v", receipt, err)
	}
	if _, err := server.db.ExecContext(ctx, "DELETE FROM protected_messages WHERE channel_id=? AND position=2", second.ChannelID); err != nil {
		t.Fatal(err)
	}
	if receipt, err := appendAs(reader.Token, second); err != nil || receipt.Position != 2 || !receipt.Existing {
		t.Fatalf("retry after content removal: %+v %v", receipt, err)
	}
	if _, err := store.ApplyRoles(ctx, 1, owner.Access.EffectiveProfileID, state.Roles, state.Order,
		map[string][]string{reader.Access.EffectiveProfileID: nil}); err != nil {
		t.Fatal(err)
	}
	if _, err := appendAs(reader.Token, attempt); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("revoked profile retained receipt access: %v", err)
	}
	writeAsOwner := func(id, keyID string, nonce byte) uint64 {
		t.Helper()
		post := attempt
		post.OperationID = strings.Repeat(id, 32)
		post.KeyID = keyID
		post.Nonce = bytes.Repeat([]byte{nonce}, 12)
		post = signProtectedTestMessage(t, server, owner, 1, post)
		receipt, err := server.appendProtectedMessage(ctx, owner.Token, post)
		if err != nil {
			t.Fatal(err)
		}
		return receipt.Position
	}
	whileRevoked := writeAsOwner("3", attempt.KeyID, 3)
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.send"}}
	if _, err := store.ApplyRoles(ctx, 2, owner.Access.EffectiveProfileID, state.Roles, state.Order,
		map[string][]string{reader.Access.EffectiveProfileID: {"reader"}}); err != nil {
		t.Fatal(err)
	}
	unsafe := attempt
	unsafe.OperationID = strings.Repeat("4", 32)
	unsafe.Nonce = bytes.Repeat([]byte{4}, 12)
	unsafe = signProtectedTestMessage(t, server, owner, 1, unsafe)
	if _, err := server.appendProtectedMessage(ctx, owner.Token, unsafe); !errors.Is(err, access.ErrEpochStale) {
		t.Fatalf("old key accepted after limited-history admission: %v", err)
	}
	nextKey := strings.Repeat("c", 64)
	next, packages := prepareTestEpoch(t, server, owner, 1, attempt.ChannelID, nextKey)
	if err := server.commitProtectedEpoch(ctx, owner.Token, next, packages); err != nil {
		t.Fatal(err)
	}
	afterReadmission := writeAsOwner("4", nextKey, 4)
	projection, err := store.Project(ctx, reader.Access.EffectiveProfileID, []access.ScopedEvent{
		{ChannelID: "private", Content: true, OriginalPosition: first.Position},
		{ChannelID: "private", Content: true, OriginalPosition: whileRevoked},
		{ChannelID: "private", Content: true, OriginalPosition: afterReadmission},
	})
	if err != nil || len(projection.Events) != 1 || projection.Events[0].OriginalPosition != afterReadmission {
		t.Fatalf("readmission leaked earlier content: %+v %v", projection, err)
	}
}

func TestProtectedEpochRejectsTamperingAndConcurrentRotations(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	store, state, owner, reader := protectedTestState(t, server)
	commit := func(record access.EpochRecord, packages []access.EpochPackage) error {
		return server.commitProtectedEpoch(ctx, owner.Token, record, packages)
	}
	signed, packages := prepareTestEpoch(t, server, owner, 1, "private", strings.Repeat("a", 64))
	tampered := signed
	tampered.PackagesDigest = strings.Repeat("e", 64)
	var failure *membershipError
	if err := commit(tampered, packages); !errors.As(err, &failure) || failure.Code != "INVALID_EPOCH_SIGNATURE" {
		t.Fatalf("unsigned package change accepted: %v", err)
	}
	if err := server.commitProtectedEpoch(ctx, reader.Token, signed, packages); !errors.Is(err, access.ErrRotationLease) {
		t.Fatalf("epoch accepted with wrong authenticated signer: %v", err)
	}
	if err := commit(signed, packages); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplyRoles(ctx, 1, owner.Access.EffectiveProfileID, state.Roles, state.Order,
		map[string][]string{reader.Access.EffectiveProfileID: nil}); err != nil {
		t.Fatal(err)
	}
	if err := commit(signed, packages); !errors.Is(err, access.ErrPolicyConflict) {
		t.Fatalf("stale policy accepted: %v", err)
	}
	a, packages := prepareTestEpoch(t, server, owner, 1, "private", strings.Repeat("d", 64))
	usedTask := a
	usedTask.TaskID = signed.TaskID
	if err := commit(signTestEpoch(t, server, owner, 1, usedTask), packages); !errors.Is(err, access.ErrRotationLease) {
		t.Fatalf("committed task reused for a different rotation: %v", err)
	}
	wrongHead := a
	wrongHead.PreviousDigest = strings.Repeat("f", 64)
	if err := commit(signTestEpoch(t, server, owner, 1, wrongHead), packages); !errors.Is(err, access.ErrEpochConflict) {
		t.Fatalf("wrong predecessor accepted: %v", err)
	}
	b := a
	b.KeyID = strings.Repeat("e", 64)
	b = signTestEpoch(t, server, owner, 1, b)
	start := make(chan struct{})
	results := make(chan error, 2)
	var writers sync.WaitGroup
	for _, record := range []access.EpochRecord{a, b} {
		writers.Go(func() {
			<-start
			results <- commit(record, packages)
		})
	}
	close(start)
	writers.Wait()
	close(results)
	var accepted, conflict int
	for err := range results {
		switch {
		case err == nil:
			accepted++
		case errors.Is(err, access.ErrEpochConflict):
			conflict++
		default:
			t.Fatal(err)
		}
	}
	if accepted != 1 || conflict != 1 {
		t.Fatalf("accepted %d candidates, rejected %d conflicts", accepted, conflict)
	}
}

func TestProtectedEpochGraceIsEnforcedOnAppend(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(10000, 0)
	server.now = func() time.Time { return now }
	store, state, owner, reader := protectedTestState(t, server)
	oldKey, newKey := strings.Repeat("a", 64), strings.Repeat("b", 64)
	rotate := func(key string) {
		t.Helper()
		record, packages := prepareTestEpoch(t, server, owner, 1, "private", key)
		if err := server.commitProtectedEpoch(ctx, owner.Token, record, packages); err != nil {
			t.Fatal(err)
		}
	}
	appendAs := func(session memberSession, seed byte, key string, id int) error {
		t.Helper()
		attempt := access.MessageAttempt{ChannelID: "private", KeyID: key, OperationID: fmt.Sprintf("%032x", id),
			Nonce: bytes.Repeat([]byte{byte(id)}, 12), Ciphertext: make([]byte, 17)}
		_, err := server.appendProtectedMessage(ctx, session.Token, signProtectedTestMessage(t, server, session, seed, attempt))
		return err
	}
	rotate(oldKey)
	if _, err := store.ApplyRoles(ctx, 1, owner.Access.EffectiveProfileID, state.Roles, state.Order,
		map[string][]string{reader.Access.EffectiveProfileID: nil}); err != nil {
		t.Fatal(err)
	}
	if err := appendAs(reader, 2, oldKey, 1); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("revoked sender used grace: %v", err)
	}
	now = now.Add(59 * time.Second)
	rotate(newKey)
	if err := appendAs(owner, 1, oldKey, 2); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	if err := appendAs(owner, 1, oldKey, 3); !errors.Is(err, access.ErrEpochStale) {
		t.Fatalf("expired grace accepted: %v", err)
	}
	if err := appendAs(owner, 1, newKey, 4); err != nil {
		t.Fatal(err)
	}
	tamperedKey := strings.Repeat("c", 64)
	if _, err := server.db.Exec("UPDATE protected_epochs SET key_id=? WHERE key_id=?", tamperedKey, newKey); err != nil {
		t.Fatal(err)
	}
	if err := appendAs(owner, 1, tamperedKey, 5); !errors.Is(err, access.ErrEpochConflict) {
		t.Fatalf("unsigned database key accepted: %v", err)
	}
}

func TestProtectedOverlappingEpochRevocationsAcrossRestart(t *testing.T) {
	for _, thirdEpochAt := range []time.Duration{30 * time.Second, 60 * time.Second} {
		t.Run(thirdEpochAt.String(), func(t *testing.T) {
			ctx := t.Context()
			start := time.Unix(10000, 0)
			now := start
			clock := func() time.Time { return now }
			path := filepath.Join(t.TempDir(), "room.sqlite")
			server, err := openMembershipDatabase(path, clock)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { server.db.Close() }()
			var secondReader memberSession
			store, state, owner, firstReader := protectedTestStateWith(t, server, func(state *access.State) {
				identity := newTestMemberSigner(3)
				activateTestMember(t, server, identity, "member")
				secondReader = loginTestMember(t, server, identity)
				profile, device := secondReader.Access.EffectiveProfileID, secondReader.Access.DeviceID
				state.Members[profile] = access.Subject{ID: profile, Active: true, Roles: []string{"reader"}}
				state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
				state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 33)}
			})
			rotate := func(key string) {
				t.Helper()
				record, packages := prepareTestEpoch(t, server, owner, 1, "private", key)
				if err := server.commitProtectedEpoch(ctx, owner.Token, record, packages); err != nil {
					t.Fatal(err)
				}
			}
			revoke := func(revision int64, reader memberSession) int64 {
				t.Helper()
				next, err := store.ApplyRoles(ctx, revision, owner.Access.EffectiveProfileID, state.Roles, state.Order,
					map[string][]string{reader.Access.EffectiveProfileID: nil})
				if err != nil {
					t.Fatal(err)
				}
				return next
			}
			operation := 0
			checkSend := func(sender memberSession, seed byte, key string, want error) {
				t.Helper()
				operation++
				attempt := access.MessageAttempt{ChannelID: "private", KeyID: key, OperationID: fmt.Sprintf("%032x", operation),
					Nonce: bytes.Repeat([]byte{byte(operation)}, 12), Ciphertext: make([]byte, 17)}
				_, err := server.appendProtectedMessage(ctx, sender.Token, signProtectedTestMessage(t, server, sender, seed, attempt))
				if !errors.Is(err, want) {
					t.Fatalf("send with key %s at %s returned %v, want %v", key[:1], now.Sub(start), err, want)
				}
			}
			firstKey, secondKey, thirdKey := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
			rotate(firstKey)
			revision := revoke(1, firstReader)
			now = start.Add(10 * time.Second)
			rotate(secondKey)
			now = start.Add(20 * time.Second)
			revoke(revision, secondReader)
			if err := server.db.Close(); err != nil {
				t.Fatal(err)
			}
			// Reopen the persisted database directly. Its protected adapter owns the policy and epoch tables.
			source := (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(path), "/"),
				RawQuery: "_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"}).String()
			db, err := sql.Open("sqlite", source)
			if err != nil {
				t.Fatal(err)
			}
			server = &membershipStore{db: db, now: clock}
			now = start.Add(thirdEpochAt - time.Second)
			checkSend(firstReader, 2, firstKey, access.ChannelRestricted)
			checkSend(secondReader, 3, secondKey, access.ChannelRestricted)
			checkSend(owner, 1, firstKey, nil)
			now = start.Add(thirdEpochAt)
			if thirdEpochAt == 60*time.Second {
				checkSend(owner, 1, firstKey, access.ErrEpochStale)
			}
			rotate(thirdKey)
			checkSend(owner, 1, firstKey, access.ErrEpochStale)
			now = start.Add(80*time.Second - time.Millisecond)
			checkSend(owner, 1, secondKey, nil)
			now = start.Add(80 * time.Second)
			checkSend(owner, 1, secondKey, access.ErrEpochStale)
			checkSend(owner, 1, thirdKey, nil)
		})
	}
}

func TestProtectedRotationLeaseFallbackAndExactRecipientManifest(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(10000, 0)
	server.now = func() time.Time { return now }
	store, state, owner, reader := protectedTestState(t, server)
	if _, err := server.claimProtectedRotation(ctx, reader.Token, "private", access.LiveEpoch); !errors.Is(err, access.ErrRotationLease) {
		t.Fatalf("initiator priority bypassed: %v", err)
	}
	ownerRecord, ownerPackages := prepareTestEpoch(t, server, owner, 1, "private", strings.Repeat("a", 64))
	now = now.Add(14 * time.Second)
	if _, err := server.claimProtectedRotation(ctx, reader.Token, "private", access.LiveEpoch); !errors.Is(err, access.ErrRotationLease) {
		t.Fatalf("active lease stolen: %v", err)
	}
	now = now.Add(time.Second)
	fallback, packages := prepareTestEpoch(t, server, reader, 2, "private", strings.Repeat("b", 64))
	if fallback.TaskID != ownerRecord.TaskID || fallback.LeaseID == ownerRecord.LeaseID {
		t.Fatal("fallback did not retain the task and replace the lease")
	}
	if err := server.commitProtectedEpoch(ctx, owner.Token, ownerRecord, ownerPackages); !errors.Is(err, access.ErrRotationLease) {
		t.Fatalf("expired executor published: %v", err)
	}
	if err := server.commitProtectedEpoch(ctx, reader.Token, fallback, packages); err != nil {
		t.Fatal(err)
	}

	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.send"}}
	if _, err := store.ApplyRoles(ctx, 1, owner.Access.EffectiveProfileID, state.Roles, state.Order, nil); err != nil {
		t.Fatal(err)
	}
	now = now.Add(5 * time.Second)
	if _, err := server.claimProtectedRotation(ctx, reader.Token, "private", access.ArchiveEpoch); !errors.Is(err, access.ErrRotationUnavailable) {
		t.Fatalf("limited reader could extend archive head: %v", err)
	}
	rotation, packages := prepareTestEpoch(t, server, owner, 1, "private", strings.Repeat("c", 64))
	reject := func(items []access.EpochPackage) {
		t.Helper()
		candidate := rotation
		var err error
		candidate.PackagesDigest, err = access.PackagesDigest(items)
		if err != nil {
			t.Fatal(err)
		}
		candidate = signTestEpoch(t, server, owner, 1, candidate)
		if err := server.commitProtectedEpoch(ctx, owner.Token, candidate, items); !errors.Is(err, access.ErrEpochRecipients) {
			t.Fatalf("invalid recipient manifest accepted: %v", err)
		}
	}
	reject(packages[1:])
	reject(append(append([]access.EpochPackage(nil), packages...), packages[0]))
	reject(append(append([]access.EpochPackage(nil), packages...), access.EpochPackage{
		RecipientID: reader.Access.DeviceID, Purpose: "archive", Ciphertext: make([]byte, access.EpochPackageSize),
	}))
	reject(append(append([]access.EpochPackage(nil), packages...), access.EpochPackage{
		RecipientID: strings.Repeat("f", 64), Purpose: "live", Ciphertext: make([]byte, access.EpochPackageSize),
	}))
	altered := append([]access.EpochPackage(nil), packages...)
	altered[0].Ciphertext = make([]byte, access.EpochPackageSize)
	if err := server.commitProtectedEpoch(ctx, owner.Token, rotation, altered); !errors.Is(err, access.ErrEpochRecipients) {
		t.Fatalf("unsigned package bytes accepted: %v", err)
	}
	if err := server.commitProtectedEpoch(ctx, owner.Token, rotation, packages); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := server.db.QueryRow("SELECT count(*) FROM protected_epoch_packages WHERE channel_id=? AND generation=?", "private", rotation.Generation).Scan(&count); err != nil ||
		count != len(packages) {
		t.Fatalf("wrong persisted package count: %d, %v", count, err)
	}
}

func TestProtectedLimitedReaderRotatesLiveWhileArchivePending(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(10000, 0)
	server.now = func() time.Time { return now }
	store, state, owner, reader := protectedTestState(t, server)
	initial, packages := prepareTestEpoch(t, server, owner, 1, "private", strings.Repeat("a", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, initial, packages); err != nil {
		t.Fatal(err)
	}
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.send"}}
	if _, err := store.ApplyRoles(ctx, 1, owner.Access.EffectiveProfileID, state.Roles, state.Order, nil); err != nil {
		t.Fatal(err)
	}
	now = now.Add(6 * time.Second)
	archive, archivePackages := prepareTestEpochForPurpose(t, server, owner, 1, "private", strings.Repeat("b", 64), access.ArchiveEpoch)
	links := []access.ArchiveLink{{
		ArchiveTarget: access.ArchiveTarget{Purpose: access.LiveEpoch, Generation: initial.Generation, KeyID: initial.KeyID},
		Ciphertext:    make([]byte, access.ArchiveLinkSize),
	}}
	linkDigest, err := access.ArchiveLinksDigest(links)
	if err != nil {
		t.Fatal(err)
	}
	archive.ArchiveLinksDigest = linkDigest
	archive = signTestEpoch(t, server, owner, 1, archive)
	live, livePackages := prepareTestEpoch(t, server, reader, 2, "private", strings.Repeat("c", 64))
	if archive.TaskID == live.TaskID || len(archivePackages) != 1 || len(livePackages) != 2 {
		t.Fatalf("rotation purposes shared a lease or recipient set: %d, %d", len(archivePackages), len(livePackages))
	}
	if err := server.commitProtectedEpoch(ctx, reader.Token, live, livePackages); err != nil {
		t.Fatal(err)
	}
	attempt := access.MessageAttempt{ChannelID: "private", OperationID: strings.Repeat("1", 32), KeyID: live.KeyID,
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17)}
	if _, err := server.appendProtectedMessage(ctx, reader.Token, signProtectedTestMessage(t, server, reader, 2, attempt)); err != nil {
		t.Fatalf("live send depends on pending archive: %v", err)
	}
	if err := server.commitProtectedEpoch(ctx, owner.Token, archive, archivePackages); !errors.Is(err, access.ErrEpochConflict) {
		t.Fatalf("archive without required links accepted: %v", err)
	}
	if err := server.commitProtectedEpoch(ctx, owner.Token, archive, archivePackages, links...); err != nil {
		t.Fatalf("live commit invalidated independent archive lease: %v", err)
	}
	snapshot, _, err := store.Snapshot(ctx)
	if err != nil || snapshot.ArchiveHeads["private"] != 1 || snapshot.EpochWindows["private"].Current != 2 {
		t.Fatalf("epoch heads did not advance independently: %v", err)
	}
	pending, err := server.claimProtectedRotation(ctx, owner.Token, "private", access.ArchiveEpoch)
	if err != nil || pending.ArchiveThrough != 2 || len(pending.ArchiveTargets) != 2 ||
		pending.ArchiveTargets[0].KeyID != archive.KeyID || pending.ArchiveTargets[1].KeyID != live.KeyID {
		t.Fatalf("archive catch-up lost predecessor or concurrent live extent: %+v, %v", pending.ArchiveTargets, err)
	}
	if _, err := server.loadProtectedEpochPackage(ctx, owner.Token, "private", archive.KeyID, access.ArchiveEpoch); err != nil {
		t.Fatalf("archive package unavailable: %v", err)
	}
	if _, err := server.loadProtectedEpochPackage(ctx, reader.Token, "private", archive.KeyID, access.ArchiveEpoch); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("limited reader obtained archive package: %v", err)
	}
	delivered, err := server.loadProtectedArchiveLinks(ctx, owner.Token, "private", archive.KeyID)
	if err != nil || len(delivered.Links) != 1 || delivered.Links[0].KeyID != initial.KeyID {
		t.Fatalf("authorized archive links unavailable: %v", err)
	}
	if _, err := server.loadProtectedArchiveLinks(ctx, reader.Token, "private", archive.KeyID); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("limited reader obtained archived links: %v", err)
	}
	attempt.KeyID, attempt.OperationID = archive.KeyID, strings.Repeat("2", 32)
	if _, err := server.appendProtectedMessage(ctx, owner.Token, signProtectedTestMessage(t, server, owner, 1, attempt)); !errors.Is(err, access.ErrEpochStale) {
		t.Fatalf("archive key accepted for live send: %v", err)
	}
}

func TestProtectedWebSocketDropsQueuedChannelOnRevoke(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	store, state, owner, reader := protectedTestState(t, server)
	key := "dGhlIHNhbXBsZSBub25jZQ=="
	batches := make(chan []access.ScopedEvent)
	exited := make(chan struct{})
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(exited)
		provided := r.Header.Get("Sec-WebSocket-Key")
		decoded, err := base64.StdEncoding.DecodeString(provided)
		if err != nil || len(decoded) != 16 {
			w.WriteHeader(400)
			return
		}
		conn, _, err := upgradeMembershipWS(w, provided)
		if err != nil {
			return
		}
		defer conn.Close()
		for batch := range batches {
			if err := server.dispatchProtectedBatch(r.Context(), conn, memberBearer(r), batch); err != nil {
				writeWS(conn, 8, []byte{3, 240})
				return
			}
		}
	}))
	defer web.Close()
	defer close(batches)
	conn, err := net.Dial("tcp", web.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "GET /fixture HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n",
		web.Listener.Addr(), reader.Token, key)
	wire := bufio.NewReader(conn)
	response, err := http.ReadResponse(wire, nil)
	if err != nil || response.StatusCode != 101 {
		t.Fatalf("handshake: %v %v", response, err)
	}
	frame := func() (byte, []byte) {
		t.Helper()
		var header [2]byte
		if _, err := io.ReadFull(wire, header[:]); err != nil {
			t.Fatal(err)
		}
		size := uint16(header[1] & 127)
		if size == 126 {
			if err := binary.Read(wire, binary.BigEndian, &size); err != nil {
				t.Fatal(err)
			}
		}
		payload := make([]byte, size)
		if _, err := io.ReadFull(wire, payload); err != nil {
			t.Fatal(err)
		}
		return header[0] & 15, payload
	}
	queued := []access.ScopedEvent{{ChannelID: "private", Payload: []byte("channel metadata")}}
	attempt := access.MessageAttempt{
		ChannelID: "private", OperationID: strings.Repeat("3", 32), KeyID: strings.Repeat("a", 64),
		Nonce: make([]byte, 12), Ciphertext: bytes.Repeat([]byte{3}, 17), Signature: make([]byte, 64),
	}
	genesis, packages := prepareTestEpoch(t, server, owner, 1, attempt.ChannelID, attempt.KeyID)
	if err := server.commitProtectedEpoch(ctx, owner.Token, genesis, packages); err != nil {
		t.Fatal(err)
	}
	attempt = signProtectedTestMessage(t, server, owner, 1, attempt)
	receipt, err := server.appendProtectedMessage(ctx, owner.Token, attempt)
	if err != nil {
		t.Fatal(err)
	}
	queued = append(queued, access.ScopedEvent{
		ChannelID: attempt.ChannelID, OriginalPosition: receipt.Position, Content: true, Payload: attempt.Ciphertext,
	})
	batches <- queued
	op, payload := frame()
	var projection access.Projection
	if err := json.Unmarshal(payload, &projection); err != nil || op != 1 || len(projection.Events) != 2 {
		t.Fatalf("initial frame: %d %s %v", op, payload, err)
	}
	if _, err := store.ApplyRoles(ctx, 1, owner.Access.EffectiveProfileID, state.Roles, state.Order,
		map[string][]string{reader.Access.EffectiveProfileID: nil}); err != nil {
		t.Fatal(err)
	}
	batches <- queued
	op, payload = frame()
	if err := json.Unmarshal(payload, &projection); err != nil || op != 1 || len(projection.Channels) != 0 || len(projection.Events) != 0 {
		t.Fatalf("revoked frame: %d %s %v", op, payload, err)
	}
	if _, err := server.db.ExecContext(ctx, "DELETE FROM sessions WHERE session_id=?", reader.Access.SessionID); err != nil {
		t.Fatal(err)
	}
	batches <- queued
	if op, _ := frame(); op != 8 {
		t.Fatalf("invalid session received opcode %d", op)
	}
	<-exited
}
