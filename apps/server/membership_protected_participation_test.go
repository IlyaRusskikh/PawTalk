package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedParticipationAndPollPermissionsTLS(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	server.now = func() time.Time { return time.UnixMilli(clock.Load()) }
	channel, item := strings.Repeat("a", 32), strings.Repeat("b", 32)
	readOnly := []string{access.ChannelView, "history.full", "poll.vote", "checklist.check", "message.delete-other"}
	var author memberSession
	store, initial, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Channels = map[string]access.Channel{channel: {Kind: "text", NextPosition: 1}}
		state.Roles["reader"] = access.Role{Grants: readOnly}
		state.Roles["author"] = access.Role{Grants: []string{access.ChannelView, "history.full", "message.send", "poll.create", "poll.vote", "checklist.create", "checklist.check"}}
		state.Order = append(state.Order, "author")
		identity := newTestMemberSigner(3)
		activateTestMember(t, server, identity, "member")
		author = loginTestMember(t, server, identity)
		profile, device := author.Access.EffectiveProfileID, author.Access.DeviceID
		state.Members[profile] = access.Subject{ID: profile, Roles: []string{"author"}, Active: true}
		state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 33)}
	})
	policyToken := owner.Token
	commitPolicy := func(draft access.PolicyDraft) access.PolicyProof {
		t.Helper()
		preview, err := server.previewProtectedPolicy(ctx, policyToken, draft)
		if err != nil {
			t.Fatal(err)
		}
		proof, err := server.commitProtectedPolicy(ctx, policyToken, signTestPolicyDraft(t, server, owner, 1, preview))
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	operation := func(id int) string { return fmt.Sprintf("%032x", id) }
	anchor := commitPolicy(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: operation(1)})
	epoch, packages := prepareTestEpoch(t, server, owner, 1, channel, strings.Repeat("c", 64))
	if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := server.db.QueryRow("SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	server.protectedBinding = strings.Repeat("d", 64)
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema+protectedVoiceKeySchema); err != nil {
		t.Fatal(err)
	}
	runtime := &protectedRuntime{store: server, serverID: serverID, cutoverDigest: strings.Repeat("e", 64),
		anchorDigest: anchor.Digest, challenges: make(map[string]int64)}
	login := func(member memberSession, seed byte) string {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		frame, err := signatureFrame("pawtalk-protected-session-v1", serverID, runtime.cutoverDigest, server.protectedBinding,
			challenge.Nonce, member.Access.DeviceID)
		if err != nil {
			t.Fatal(err)
		}
		session, err := runtime.openSession(ctx, protectedSessionRequest{DeviceID: member.Access.DeviceID, Nonce: challenge.Nonce,
			Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))})
		if err != nil {
			t.Fatal(err)
		}
		return session.Token
	}
	ownerToken, readerToken, authorToken := login(owner, 1), login(reader, 2), login(author, 3)
	policyToken = ownerToken
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	request := func(token, method, route string, input any, status int, code string, output any) []byte {
		t.Helper()
		var body []byte
		if input != nil {
			var err error
			body, err = json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, room.URL+"/api/v3"+route, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		response, err := room.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != status || code != "" && !bytes.Contains(raw, []byte(`"code":"`+code+`"`)) {
			t.Fatalf("%s %s: got %d %s, want %d %s (%v)", method, route, response.StatusCode, raw, status, code, err)
		}
		if output != nil {
			if err := json.Unmarshal(raw, output); err != nil {
				t.Fatalf("%s %s has invalid body: %s (%v)", method, route, raw, err)
			}
		}
		return raw
	}
	appendMessage := func(token string, member memberSession, seed byte, op int, poll *access.MessagePoll, checklist *access.MessageChecklist,
		status int, code string) uint64 {
		t.Helper()
		packet := signProtectedTestMessage(t, server, member, seed, access.MessageAttempt{ChannelID: channel, KeyID: epoch.KeyID,
			OperationID: operation(op), Nonce: bytes.Repeat([]byte{byte(op)}, 12), Ciphertext: make([]byte, 17), Poll: poll, Checklist: checklist})
		var receipt access.MessageReceipt
		request(token, http.MethodPost, "/history/live/"+channel, packet, status, code, &receipt)
		return receipt.Position
	}
	appendMessage(readerToken, reader, 2, 2, nil, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED")
	poll := appendMessage(authorToken, author, 3, 3, &access.MessagePoll{OptionCount: 2, Duration: 3600, Anonymous: true}, nil, http.StatusOK, "")
	shared := appendMessage(authorToken, author, 3, 4, nil, &access.MessageChecklist{Items: []string{item}, Everyone: true}, http.StatusOK, "")
	personal := appendMessage(authorToken, author, 3, 5, nil, &access.MessageChecklist{Items: []string{item}}, http.StatusOK, "")
	readOnlyOwn := appendMessage(authorToken, author, 3, 21, nil, nil, http.StatusOK, "")
	timedOutOwn := appendMessage(authorToken, author, 3, 22, nil, nil, http.StatusOK, "")
	ownerMessage := appendMessage(ownerToken, owner, 1, 23, nil, nil, http.StatusOK, "")
	pollPath := fmt.Sprintf("/history/poll/%s/%d", channel, poll)
	sharedPath, personalPath := fmt.Sprintf("/history/checklist/%s/%d", channel, shared), fmt.Sprintf("/history/checklist/%s/%d", channel, personal)
	denied, timedOut := "PROTECTED_ACCESS_DENIED", "PROTECTED_TIMED_OUT"
	check := func(token, route string, op int, checked bool, status int, code string) {
		t.Helper()
		request(token, http.MethodPut, route, access.ChecklistChange{OperationID: operation(op), Item: item, Checked: checked}, status, code, nil)
	}
	vote := func(token string, op, choice, status int, code string) {
		t.Helper()
		request(token, http.MethodPut, pollPath, map[string]any{"operationId": operation(op), "choices": []int{choice}}, status, code, nil)
	}
	readPoll := func(token string) access.PollState {
		t.Helper()
		var state access.PollState
		raw := request(token, http.MethodGet, pollPath, nil, http.StatusOK, "", &state)
		if !state.Anonymous || bytes.Contains(raw, []byte(`"voters"`)) || bytes.Contains(raw, []byte(reader.Access.EffectiveProfileID)) ||
			bytes.Contains(raw, []byte(author.Access.EffectiveProfileID)) {
			t.Fatalf("anonymous ballot identity disclosed: %s", raw)
		}
		return state
	}
	readChecklist := func(token, route string, canCheck, checked bool) {
		t.Helper()
		var state access.ChecklistState
		request(token, http.MethodGet, route, nil, http.StatusOK, "", &state)
		if state.CanCheck != canCheck || state.Checked[item] != checked {
			t.Fatalf("incorrect checklist capabilities/state: %+v", state)
		}
	}
	check(readerToken, sharedPath, 6, true, http.StatusOK, "")
	readChecklist(authorToken, sharedPath, true, true)
	readChecklist(readerToken, personalPath, false, false)
	check(readerToken, personalPath, 7, true, http.StatusForbidden, denied)
	check(authorToken, personalPath, 7, true, http.StatusOK, "")
	vote(readerToken, 8, 0, http.StatusOK, "")
	vote(authorToken, 9, 1, http.StatusOK, "")
	if ballot := readPoll(readerToken); !ballot.CanVote || ballot.CanClose || len(ballot.Counts) != 0 || !slices.Equal(ballot.Own, []int{0}) {
		t.Fatalf("unexpected read-only poll state: %+v", ballot)
	}
	var timeout access.TimeoutReceipt
	request(ownerToken, http.MethodPut, "/moderation/timeout/"+reader.Access.EffectiveProfileID,
		access.TimeoutRequest{OperationID: operation(10), DurationSeconds: 60, Reason: "Participation fixture"}, http.StatusOK, "", &timeout)
	if timeout.Deadline != clock.Load()+60_000 {
		t.Fatalf("incorrect timeout deadline: %+v", timeout)
	}
	vote(readerToken, 11, 1, http.StatusForbidden, timedOut)
	check(readerToken, sharedPath, 12, false, http.StatusForbidden, timedOut)
	if ballot := readPoll(readerToken); ballot.CanVote || !slices.Equal(ballot.Own, []int{0}) {
		t.Fatalf("timeout changed the existing ballot: %+v", ballot)
	}
	readChecklist(readerToken, sharedPath, false, true)
	clock.Store(timeout.Deadline)
	vote(readerToken, 11, 1, http.StatusOK, "")
	check(readerToken, sharedPath, 12, false, http.StatusOK, "")
	readChecklist(authorToken, sharedPath, true, false)

	request(readerToken, http.MethodPut, pollPath+"/close", nil, http.StatusForbidden, denied, nil)
	setReaderPermissions := func(id int, grant string) {
		t.Helper()
		initial.Roles["reader"] = access.Role{Grants: append(slices.Clone(readOnly), grant)}
		commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: operation(id),
			RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order}})
	}
	setReaderPermissions(13, "poll.delete-completed")
	request(readerToken, http.MethodPut, pollPath+"/close", nil, http.StatusForbidden, denied, nil)
	request(readerToken, http.MethodDelete, pollPath, nil, http.StatusForbidden, denied, nil)
	setReaderPermissions(14, "poll.close-other")
	if ballot := readPoll(readerToken); !ballot.CanClose || ballot.ClosedAt != nil {
		t.Fatalf("close-only role cannot close the higher-ranked author’s poll: %+v", ballot)
	}
	request(readerToken, http.MethodPut, pollPath+"/close", nil, http.StatusOK, "", nil)
	request(readerToken, http.MethodPut, pollPath+"/close", nil, http.StatusOK, "", nil)
	for _, token := range []string{ownerToken, readerToken, authorToken} {
		if ballot := readPoll(token); ballot.CanClose || ballot.CanVote || ballot.ClosedAt == nil ||
			*ballot.ClosedAt != clock.Load() || ballot.Total != 2 || !slices.Equal(ballot.Counts, []int{0, 2}) {
			t.Fatalf("close did not freeze the anonymous tally: %+v", ballot)
		}
	}
	vote(readerToken, 15, 0, http.StatusConflict, "POLL_CLOSED")
	if err := store.PublishPollResult(ctx, channel, poll, false, signProtectedPollResult); err != nil {
		t.Fatal(err)
	}
	var result uint64
	if err := server.db.QueryRow(`SELECT position FROM protected_poll_results WHERE channel_id=? AND original_position=?`, channel, poll).Scan(&result); err != nil {
		t.Fatal(err)
	}
	historyPath := "/history/live/" + channel + "?after=0&limit=8"
	readPair := func(expected bool) {
		t.Helper()
		var page access.LiveMessagePage
		request(readerToken, http.MethodGet, historyPath, nil, http.StatusOK, "", &page)
		var hasPoll, hasResult bool
		for _, message := range page.Messages {
			hasPoll = hasPoll || message.Position == poll && message.Packet.Poll != nil
			hasResult = hasResult || message.Position == result && message.PollResult != nil && message.PollResult.Original == poll
		}
		if hasPoll != expected || hasResult != expected {
			t.Fatalf("poll and linked result visibility: got %t/%t, want both %t", hasPoll, hasResult, expected)
		}
	}
	readPair(true)
	request(authorToken, http.MethodDelete, pollPath, nil, http.StatusForbidden, denied, nil)
	request(readerToken, http.MethodDelete, pollPath, nil, http.StatusForbidden, denied, nil)
	rejectEdit := func(token string, position uint64, code string) {
		t.Helper()
		route := fmt.Sprintf("/history/revision/%s/%d", channel, position)
		request(token, http.MethodGet, route+"/basis", nil, http.StatusForbidden, code, nil)
		attempt := access.RevisionAttempt{
			RevisionExpectation: access.RevisionExpectation{Revision: 2, PolicyRevision: 1, PolicyDigest: strings.Repeat("a", 64),
				PreviousDigest: strings.Repeat("b", 64), ArchiveDigest: strings.Repeat("c", 64)},
			OperationID: operation(24),
			Packet: access.RevisionPacket{Nonce: make([]byte, 12), Ciphertext: make([]byte, 17),
				ArchivePackage: make([]byte, access.EpochPackageSize), Signature: make([]byte, ed25519.SignatureSize),
				RecipientDigest: strings.Repeat("d", 64)},
		}
		request(token, http.MethodPut, route, attempt, http.StatusForbidden, code, nil)
	}
	deleteMessage := func(token string, position uint64, status int, code string) {
		t.Helper()
		request(token, http.MethodDelete, fmt.Sprintf("/history/message/%s/%d", channel, position), nil, status, code, nil)
	}
	setAuthorGrants := func(id int, role access.Role) {
		t.Helper()
		initial.Roles["author"] = role
		commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: operation(id),
			RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order}})
	}
	authorRole := initial.Roles["author"]
	readOnlyAuthor := authorRole
	readOnlyAuthor.Grants = slices.DeleteFunc(slices.Clone(authorRole.Grants), func(grant string) bool { return grant == "message.send" })
	setAuthorGrants(25, readOnlyAuthor)
	rejectEdit(authorToken, readOnlyOwn, denied)
	deleteMessage(authorToken, readOnlyOwn, http.StatusOK, "")
	deleteMessage(authorToken, readOnlyOwn, http.StatusOK, "")
	request(authorToken, http.MethodDelete, pollPath, nil, http.StatusForbidden, denied, nil)
	deleteMessage(authorToken, poll, http.StatusConflict, "PROTECTED_MESSAGE_DELETION_RESTRICTED")

	setAuthorGrants(26, authorRole)
	request(ownerToken, http.MethodPut, "/moderation/timeout/"+author.Access.EffectiveProfileID,
		access.TimeoutRequest{OperationID: operation(27), DurationSeconds: 60, Reason: "Message deletion fixture"},
		http.StatusOK, "", nil)
	rejectEdit(authorToken, timedOutOwn, timedOut)
	deleteMessage(authorToken, timedOutOwn, http.StatusOK, "")
	request(authorToken, http.MethodDelete, pollPath, nil, http.StatusForbidden, denied, nil)
	deleteMessage(authorToken, poll, http.StatusConflict, "PROTECTED_MESSAGE_DELETION_RESTRICTED")

	rejectEdit(readerToken, ownerMessage, denied)
	deleteMessage(readerToken, ownerMessage, http.StatusOK, "")
	deleteMessage(readerToken, ownerMessage, http.StatusOK, "")
	var normalDeletes int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM protected_audit_events WHERE action='message.delete' AND channel_id=?
		AND (actor=? AND position IN (?,?) OR actor=? AND position=?)`, channel,
		author.Access.EffectiveProfileID, readOnlyOwn, timedOutOwn, reader.Access.EffectiveProfileID, ownerMessage).
		Scan(&normalDeletes); err != nil || normalDeletes != 3 {
		t.Fatalf("expected one audited deletion per ordinary message: %d, %v", normalDeletes, err)
	}
	readPair(true)
	setReaderPermissions(16, "poll.delete-completed")
	request(readerToken, http.MethodDelete, pollPath, nil, http.StatusOK, "", nil)
	request(readerToken, http.MethodGet, pollPath, nil, http.StatusForbidden, denied, nil)
	readPair(false)
	var removed int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM protected_message_deletions WHERE channel_id=? AND position IN (?,?)`,
		channel, poll, result).Scan(&removed); err != nil || removed != 2 {
		t.Fatalf("expected one deletion marker for each linked position: %d, %v", removed, err)
	}
}
