package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedScopedChannelSettings(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(10_000, 0)
	server.now = func() time.Time { return now }
	const (
		category = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
		channel  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		hidden   = "cccccccccccccccccccccccccccccccc"
		missing  = "dddddddddddddddddddddddddddddddd"
		voice    = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	)
	oldSettings := access.ChannelSettings{Name: "Original room", Description: "Independent settings proof"}
	var viewer memberIdentity
	policy, _, owner, editor := protectedTestStateWith(t, server, func(state *access.State) {
		viewer = activateTestMember(t, server, newTestMemberSigner(3), "member")
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "channel.edit", "message.send", "history.full", "voice.connect"}}
		state.Roles["viewer"] = access.Role{Grants: []string{access.ChannelView}}
		state.Order = []string{"viewer", "reader"}
		state.Members[viewer.ProfileID] = access.Subject{ID: viewer.ProfileID, Active: true, Roles: []string{"viewer"}}
		state.PolicyDevices[viewer.DeviceID] = access.PolicyDevice{ProfileID: viewer.ProfileID, PublicKey: testSigningKey(3)}
		state.KeyRecipients[viewer.DeviceID] = access.KeyRecipient{ProfileID: viewer.ProfileID, Kind: "device", PublicKey: testRecipientKey(t, 33)}
		state.Categories = map[string]access.ACL{category: {}}
		state.CategoryOrder = []string{category}
		delete(state.Channels, "private")
		state.Channels[channel] = access.Channel{Kind: "text", CategoryID: category, NextPosition: 1, Settings: &oldSettings,
			ACL: access.ACL{Roles: map[string]access.Overwrite{"viewer": {Deny: []string{"message.send"}}}}}
		state.Channels[hidden] = access.Channel{Kind: "text", CategoryID: category, NextPosition: 1,
			Settings: &access.ChannelSettings{Name: "Hidden channel"}, ACL: access.ACL{
				Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}, "viewer": {Deny: []string{access.ChannelView}}}}}
		state.Channels[voice] = access.Channel{Kind: "voice", CategoryID: category, NextPosition: 1,
			Settings: &access.ChannelSettings{Name: "Voice room", VoiceCapacity: 1}}
		state.ChannelOrder = []string{channel, hidden, voice}
	})
	preview, err := policy.PreviewPolicyForTransport(ctx, server.protectedSession(owner.Token), access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, preview.Draft))
	if err != nil || anchor.Draft.TextProjectionVersion != access.ChannelSettingsProjectionVersion {
		t.Fatalf("sign v9 anchor: %v", err)
	}
	live, packages := prepareTestEpoch(t, server, owner, 1, channel, strings.Repeat("8", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, live, packages); err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema); err != nil {
		t.Fatal(err)
	}
	server.protectedBinding = strings.Repeat("9", 64)
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: strings.Repeat("c", 64),
		anchorDigest: anchor.Digest, challenges: make(map[string]int64)}
	open := func(device string, seed byte) protectedSessionReceipt {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest, server.protectedBinding, challenge.Nonce, device)
		if err != nil {
			t.Fatal(err)
		}
		session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: device, Nonce: challenge.Nonce,
			Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	delegate, visibleReader := open(editor.Access.DeviceID, 2), open(viewer.DeviceID, 3)
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	call := func(method, path, token string, input any, status int, code string, output any) {
		t.Helper()
		payload, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		request, err := http.NewRequestWithContext(ctx, method, room.URL+"/api/v3"+path, bytes.NewReader(payload))
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
		raw, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status || (code != "" && !bytes.Contains(raw, []byte(`"`+code+`"`))) {
			t.Fatalf("%s %s status %d, want %d %s: %s", method, path, response.StatusCode, status, code, raw)
		}
		if output != nil {
			if err := json.Unmarshal(raw, output); err != nil {
				t.Fatal(err)
			}
		}
	}
	settingsPath, orderPath := "/policy/channel-settings/", "/policy/channel-order/"
	var scope access.ChannelSettingsDisclosure
	call(http.MethodGet, settingsPath+channel, visibleReader.Token, nil, http.StatusOK, "", &scope)
	if scope.ChannelID != channel || scope.Kind != "text" || scope.CategoryID != category || scope.Revision != anchor.Draft.Revision ||
		scope.PolicyDigest != anchor.Draft.ResultDigest || scope.Settings == nil || *scope.Settings != oldSettings || len(scope.Inclusion.Siblings) != 10 {
		t.Fatalf("visible reader received wrong scope: %+v", scope)
	}
	for _, id := range []string{hidden, missing} {
		call(http.MethodGet, settingsPath+id, delegate.Token, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
		call(http.MethodGet, orderPath+id, delegate.Token, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	}
	call(http.MethodGet, orderPath+channel, visibleReader.Token, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	call(http.MethodGet, "/policy/proofs?after=0", delegate.Token, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	var editorProof access.ChannelOrderAuthorityProof
	call(http.MethodGet, orderPath+channel, delegate.Token, nil, http.StatusOK, "", &editorProof)
	digest := func(s access.ChannelSettings) string {
		t.Helper()
		frame, err := signatureFrame("pawtalk-channel-settings-v1", s.Name, s.Description,
			strconv.FormatUint(uint64(s.SlowmodeSeconds), 10), strconv.FormatUint(uint64(s.VoiceCapacity), 10))
		if err != nil {
			t.Fatal(err)
		}
		return publicKeyID(frame)
	}
	if editorProof.Actor != (access.Principal{ProfileID: delegate.ProfileID, DeviceID: delegate.DeviceID}) ||
		editorProof.SettingsDigest != digest(oldSettings) || editorProof.TextDigest != scope.TextDigest ||
		!reflect.DeepEqual(editorProof.Inclusion, scope.Inclusion) {
		t.Fatalf("settings and editor disclosures are not bound to the same channel leaf: %+v", editorProof)
	}
	message := func(operation, nonce byte) access.MessageAttempt {
		return signProtectedTestMessage(t, server, editor, 2, access.MessageAttempt{ChannelID: channel, KeyID: live.KeyID,
			OperationID: strings.Repeat(string(operation), 32), Nonce: bytes.Repeat([]byte{nonce}, 12), Ciphertext: bytes.Repeat([]byte{3}, 17)})
	}
	call(http.MethodPost, "/history/live/"+channel, delegate.Token, message('2', 1), http.StatusOK, "", nil)
	before, revision, err := policy.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	type mutation struct {
		OperationID            string                 `json:"operationId"`
		PolicyHead             string                 `json:"policyHead"`
		PreviousSettingsDigest string                 `json:"previousSettingsDigest"`
		Settings               access.ChannelSettings `json:"settings"`
		EditorProof            string                 `json:"editorProof"`
	}
	newSettings := access.ChannelSettings{Name: "Renamed room", Description: "Scoped edit", SlowmodeSeconds: 30}
	makeMutation := func(operation byte, signer protectedSessionReceipt, signingSeed byte, head access.PolicyProof,
		channelID, kind string, old, proposed access.ChannelSettings) mutation {
		t.Helper()
		input := mutation{OperationID: strings.Repeat(string(operation), 32), PolicyHead: head.Digest,
			PreviousSettingsDigest: digest(old), Settings: proposed}
		frame, err := signatureFrame("pawtalk-protected-channel-settings-edit-v1", serverID, runtime.cutoverDigest,
			signer.ProfileID, signer.DeviceID, input.OperationID, strconv.FormatInt(head.Draft.Revision, 10), head.Digest,
			channelID, kind, category, input.PreviousSettingsDigest, digest(proposed))
		if err != nil {
			t.Fatal(err)
		}
		input.EditorProof = b64.EncodeToString(ed25519.Sign(newTestMemberSigner(signingSeed).device, frame))
		return input
	}
	valid := makeMutation('3', delegate, 2, anchor, channel, "text", oldSettings, newSettings)
	otherSigner := makeMutation('4', delegate, 3, anchor, channel, "text", oldSettings, newSettings)
	call(http.MethodPost, settingsPath+channel, delegate.Token, otherSigner, http.StatusForbidden, "INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT", nil)
	call(http.MethodPost, settingsPath+channel, visibleReader.Token, makeMutation('5', visibleReader, 3, anchor, channel, "text", oldSettings, newSettings),
		http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	changedContents := valid
	changedContents.Settings.Name = "Different name from proof"
	call(http.MethodPost, settingsPath+channel, delegate.Token, changedContents, http.StatusForbidden, "INVALID_PROTECTED_CHANNEL_SETTINGS_EDIT", nil)
	type receipt struct {
		OperationID string `json:"operationId"`
		Revision    int64  `json:"revision"`
		Digest      string `json:"digest"`
	}
	var first, retry receipt
	call(http.MethodPost, settingsPath+channel, delegate.Token, valid, http.StatusOK, "", &first)
	call(http.MethodPost, settingsPath+channel, delegate.Token, valid, http.StatusOK, "", &retry)
	if first.OperationID != valid.OperationID || first.Revision != revision+1 || retry != first {
		t.Fatalf("scoped edit receipt mismatch: %+v, %+v", first, retry)
	}
	editPath := func(id, digest string) string { return settingsPath + id + "/edit?digest=" + digest }
	var evidence *access.ChannelSettingsEditEvidence
	call(http.MethodGet, editPath(channel, first.Digest), delegate.Token, nil, http.StatusOK, "", &evidence)
	if evidence == nil || evidence.Settings == nil || *evidence.Settings != newSettings || evidence.Digest != first.Digest ||
		evidence.Revision != first.Revision || evidence.PolicyHead != anchor.Digest || evidence.OperationID != first.OperationID ||
		evidence.EditorProof != valid.EditorProof || !reflect.DeepEqual(evidence.Authority, editorProof) {
		t.Fatalf("edit evidence did not preserve the signed settings and scoped predecessor: %+v", evidence)
	}
	call(http.MethodGet, editPath(channel, first.Digest), visibleReader.Token, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	for _, id := range []string{hidden, missing} {
		call(http.MethodGet, editPath(id, first.Digest), delegate.Token, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	}
	call(http.MethodGet, editPath(channel, anchor.Digest), delegate.Token, nil, http.StatusOK, "", &evidence)
	if evidence != nil {
		t.Fatalf("returned evidence for another commit: %+v", evidence)
	}
	call(http.MethodPost, settingsPath+channel, delegate.Token, makeMutation('6', delegate, 2, anchor, channel, "text", oldSettings, newSettings),
		http.StatusConflict, "PROTECTED_POLICY_CHANGED", nil)
	call(http.MethodPost, settingsPath+channel, delegate.Token, changedContents, http.StatusConflict, "PROTECTED_POLICY_CHANGED", nil)
	call(http.MethodPost, "/history/live/"+channel, delegate.Token, message('7', 2), http.StatusTooManyRequests, "PROTECTED_SLOWMODE", nil)
	var updated access.ChannelSettingsDisclosure
	call(http.MethodGet, settingsPath+channel, visibleReader.Token, nil, http.StatusOK, "", &updated)
	if updated.Revision != first.Revision || updated.Settings == nil || *updated.Settings != newSettings {
		t.Fatalf("reader did not observe signed settings: %+v", updated)
	}
	state, finalRevision, err := policy.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	changed := before.Channels[channel]
	changed.Settings = &newSettings
	before.Channels[channel] = changed
	if finalRevision != first.Revision || !reflect.DeepEqual(before, state) {
		t.Fatalf("scoped action changed policy or runtime state outside selected settings: revisions %d and %d", first.Revision, finalRevision)
	}
	for index, action := range []string{access.UpdateChannelACL, access.DeletePolicyChannel} {
		change := access.PolicyResourceChange{ID: voice}
		if action == access.UpdateChannelACL {
			change.ACL = &access.ACL{}
		}
		call(http.MethodPost, "/policy/preview", delegate.Token, access.PolicyDraft{
			Action: action, OperationID: strings.Repeat(string(rune('8'+index)), 32), ResourceChange: &change,
		}, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	}
	reserveVoice := func(token string) error {
		tx, err := server.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		member, actor, err := server.protectedIdentity(ctx, tx, token)
		if err != nil {
			return err
		}
		deadline := now.Add(protectedVoiceLease).UnixMilli()
		if _, err := access.ReserveVoice(ctx, tx, actor, member.SessionID, voice, now.UnixMilli(), deadline, deadline); err != nil {
			return err
		}
		return tx.Commit()
	}
	ownerSession := open(owner.Access.DeviceID, 1)
	if err := reserveVoice(delegate.Token); err != nil {
		t.Fatal(err)
	}
	if err := reserveVoice(ownerSession.Token); !errors.Is(err, access.ErrVoiceFull) {
		t.Fatalf("owner join with capacity 1: %v", err)
	}
	oldVoice := *state.Channels[voice].Settings
	newVoice := oldVoice
	newVoice.VoiceCapacity = 2
	newVoice.Description = "Two seats"
	var voiceReceipt receipt
	firstHead := access.PolicyProof{Draft: access.PolicyDraft{Revision: first.Revision}, Digest: first.Digest}
	call(http.MethodPost, settingsPath+voice, delegate.Token,
		makeMutation('a', delegate, 2, firstHead, voice, "voice", oldVoice, newVoice), http.StatusOK, "", &voiceReceipt)
	if voiceReceipt.Revision != first.Revision+1 {
		t.Fatalf("unexpected voice settings revision: %+v", voiceReceipt)
	}
	call(http.MethodGet, editPath(channel, first.Digest), delegate.Token, nil, http.StatusOK, "", &evidence)
	if evidence != nil {
		t.Fatalf("returned a historical edit as current: %+v", evidence)
	}
	if err := reserveVoice(ownerSession.Token); err != nil {
		t.Fatalf("owner join after delegated increase to 2: %v", err)
	}

	head := access.PolicyProof{Draft: access.PolicyDraft{Revision: voiceReceipt.Revision}, Digest: voiceReceipt.Digest}
	tooLong := newSettings
	tooLong.SlowmodeSeconds = 6*60*60 + 1
	call(http.MethodPost, settingsPath+channel, delegate.Token,
		makeMutation('b', delegate, 2, head, channel, "text", newSettings, tooLong),
		http.StatusBadRequest, "INVALID_PROTECTED_ACTION", nil)
	updateSlowmode := func(operation byte, seconds uint32) {
		t.Helper()
		proposed := newSettings
		proposed.SlowmodeSeconds = seconds
		var saved receipt
		call(http.MethodPost, settingsPath+channel, delegate.Token,
			makeMutation(operation, delegate, 2, head, channel, "text", newSettings, proposed), http.StatusOK, "", &saved)
		if saved.Revision != head.Draft.Revision+1 {
			t.Fatalf("unexpected slowmode change receipt: %+v", saved)
		}
		head.Draft.Revision, head.Digest = saved.Revision, saved.Digest
		newSettings = proposed
		call(http.MethodGet, settingsPath+channel, visibleReader.Token, nil, http.StatusOK, "", &updated)
		if updated.Settings == nil || *updated.Settings != proposed {
			t.Fatalf("client did not receive slowmode %d: %+v", seconds, updated)
		}
	}
	for _, boundary := range []struct {
		operation, sendOp, nonce byte
		duration                 time.Duration
	}{
		{'c', 'd', 3, time.Second},
		{'e', 'f', 4, 6 * time.Hour},
	} {
		updateSlowmode(boundary.operation, uint32(boundary.duration/time.Second))
		attempt := message(boundary.sendOp, boundary.nonce)
		now = now.Add(boundary.duration - time.Millisecond)
		call(http.MethodPost, "/history/live/"+channel, delegate.Token, attempt, http.StatusTooManyRequests, "PROTECTED_SLOWMODE", nil)
		now = now.Add(time.Millisecond)
		call(http.MethodPost, "/history/live/"+channel, delegate.Token, attempt, http.StatusOK, "", nil)
	}
	updateSlowmode('0', 0)
	call(http.MethodPost, "/history/live/"+channel, delegate.Token, message('0', 5), http.StatusOK, "", nil)
}
