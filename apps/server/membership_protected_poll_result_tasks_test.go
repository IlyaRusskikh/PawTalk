package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedPollResultTasksWaitForRotationAndRespectHistory(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	server.now = func() time.Time { return time.UnixMilli(clock.Load()) }
	channel := strings.Repeat("a", 32)
	var late memberSession
	store, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Channels = map[string]access.Channel{channel: {Kind: "text", NextPosition: 1}}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "history.full", "poll.vote"}}
		state.Roles["late"] = access.Role{}
		state.Order = append(state.Order, "late")
		identity := newTestMemberSigner(3)
		activateTestMember(t, server, identity, "member")
		late = loginTestMember(t, server, identity)
		profile, device := late.Access.EffectiveProfileID, late.Access.DeviceID
		state.Members[profile] = access.Subject{ID: profile, Roles: []string{"late"}, Active: true}
		state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 33)}
	})
	policyToken := owner.Token
	commitPolicy := func(request access.PolicyDraft) access.PolicyProof {
		t.Helper()
		preview, err := server.previewProtectedPolicy(ctx, policyToken, request)
		if err != nil {
			t.Fatal(err)
		}
		proof, err := server.commitProtectedPolicy(ctx, policyToken, signTestPolicyDraft(t, server, owner, 1, preview))
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := commitPolicy(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	publishLive := func(member memberSession, seed byte, key string) access.EpochRecord {
		t.Helper()
		epoch, packets := prepareTestEpoch(t, server, member, seed, channel, key)
		if err := server.commitProtectedEpoch(ctx, member.Token, epoch, packets); err != nil {
			t.Fatal(err)
		}
		return epoch
	}
	initial := publishLive(owner, 1, strings.Repeat("b", 64))
	var serverID string
	var serverKey []byte
	if err := server.db.QueryRow("SELECT server_id,identity_public_key FROM server_state WHERE id=1").Scan(&serverID, &serverKey); err != nil {
		t.Fatal(err)
	}
	server.protectedBinding = strings.Repeat("c", 64)
	if _, err := server.db.ExecContext(ctx, protectedSessionSchema+protectedVoiceKeySchema); err != nil {
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
	ownerToken, readerToken := login(owner, 1), login(reader, 2)
	policyToken = ownerToken
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	request := func(token, method, route string, input any, status int, code string, output any) {
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
		res, err := room.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil || res.StatusCode != status || code != "" && !bytes.Contains(raw, []byte(`"code":"`+code+`"`)) {
			t.Fatalf("%s %s: got %d %s, want %d %s (%v)", method, route, res.StatusCode, raw, status, code, err)
		}
		if output != nil {
			if err := json.Unmarshal(raw, output); err != nil {
				t.Fatalf("%s %s has invalid body: %s (%v)", method, route, raw, err)
			}
		}
	}

	const pollDuration = 86400
	packet := signProtectedTestMessage(t, server, owner, 1, access.MessageAttempt{ChannelID: channel, OperationID: strings.Repeat("2", 32),
		KeyID: initial.KeyID, Nonce: make([]byte, 12), Ciphertext: make([]byte, 17),
		Poll: &access.MessagePoll{OptionCount: 2, Duration: pollDuration, Anonymous: true}})
	var receipt access.MessageReceipt
	request(ownerToken, http.MethodPost, "/history/live/"+channel, packet, http.StatusOK, "", &receipt)
	pollPath := fmt.Sprintf("/history/poll/%s/%d", channel, receipt.Position)
	publicationPath := fmt.Sprintf("/history/poll-results/%s/%d", channel, receipt.Position)
	vote := func(op string, choice, status int, code string) {
		t.Helper()
		request(readerToken, http.MethodPut, pollPath, map[string]any{"operationId": strings.Repeat(op, 32), "choices": []int{choice}}, status, code, nil)
	}
	vote("3", 1, http.StatusOK, "")
	state.Roles["late"] = access.Role{Grants: []string{access.ChannelView, "poll.vote"}}
	updated := commitPolicy(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("4", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	deadline := clock.Add(pollDuration * 1000)
	reader.Token = login(reader, 2)
	readerToken = reader.Token
	lateToken := login(late, 3)
	var authorOnline bool
	if err := server.db.QueryRow("SELECT EXISTS(SELECT 1 FROM protected_runtime_sessions WHERE device_id=? AND expires_at>?)",
		owner.Access.DeviceID, deadline).Scan(&authorOnline); err != nil || authorOnline {
		t.Fatalf("author must be offline at the poll deadline: %t, %v", authorOnline, err)
	}
	if err := store.FreezeExpiredPolls(ctx, nil); err != nil {
		t.Fatal(err)
	}
	var poll access.PollState
	request(readerToken, http.MethodGet, pollPath, nil, http.StatusOK, "", &poll)
	if poll.CanVote || poll.ClosedAt == nil || *poll.ClosedAt != deadline || poll.Total != 1 || !slices.Equal(poll.Counts, []int{0, 1}) {
		t.Fatalf("deadline did not freeze the ballot during rotation: %+v", poll)
	}
	vote("5", 0, http.StatusConflict, "POLL_CLOSED")
	tasks := func(token string) []access.PollResultTask {
		t.Helper()
		var items []access.PollResultTask
		request(token, http.MethodGet, "/history/poll-results/tasks", nil, http.StatusOK, "", &items)
		return items
	}
	if items := tasks(readerToken); len(items) != 0 {
		t.Fatalf("incomplete live rotation offered a task: %+v", items)
	}
	var count int
	countResults := func(want int) {
		t.Helper()
		if err := server.db.QueryRow("SELECT COUNT(*) FROM protected_poll_results WHERE channel_id=? AND original_position=?", channel,
			receipt.Position).Scan(&count); err != nil || count != want {
			t.Fatalf("got %d result rows, want %d: %v", count, want, err)
		}
	}
	countResults(0)
	source := sha256.Sum256(packet.Signature)
	publication := func(task access.PollResultTask, member memberSession, seed byte) access.PollResultPublication {
		t.Helper()
		actor := access.Principal{ProfileID: member.Access.EffectiveProfileID, DeviceID: member.Access.DeviceID}
		frame, err := access.PollResultPublicationFrame(serverID, actor, task)
		if err != nil {
			t.Fatal(err)
		}
		return access.PollResultPublication{SourceDigest: task.SourceDigest, PolicyDigest: task.PolicyDigest, Generation: task.Generation,
			KeyID: task.KeyID, Signature: ed25519.Sign(newTestMemberSigner(seed).device, frame)}
	}
	oldTask := access.PollResultTask{ChannelID: channel, Original: receipt.Position, SourceDigest: hex.EncodeToString(source[:]),
		ClosedAt: deadline, Counts: []int{0, 1}, Total: 1, PolicyDigest: updated.Draft.ResultDigest, Generation: initial.Generation, KeyID: initial.KeyID}
	old := publication(oldTask, reader, 2)
	request(readerToken, http.MethodPost, publicationPath, old, http.StatusConflict, "PROTECTED_ROTATION_UNAVAILABLE", nil)
	countResults(0)
	next := publishLive(reader, 2, strings.Repeat("e", 64))
	items := tasks(readerToken)
	if len(items) != 1 {
		t.Fatalf("ordinary original reader did not receive exactly one task: %+v", items)
	}
	expected := oldTask
	expected.Generation, expected.KeyID = next.Generation, next.KeyID
	task := items[0]
	if task.Original != expected.Original || task.ChannelID != expected.ChannelID || task.ClosedAt != deadline || task.Total != 1 ||
		!slices.Equal(task.Counts, expected.Counts) || task.SourceDigest != expected.SourceDigest ||
		task.Generation != next.Generation || task.KeyID != next.KeyID || task.PolicyDigest != expected.PolicyDigest {
		t.Fatalf("unexpected publication task: %+v", task)
	}
	if items := tasks(lateToken); len(items) != 0 {
		t.Fatalf("new limited reader received a task for a hidden poll: %+v", items)
	}
	request(lateToken, http.MethodGet, pollPath, nil, http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	request(lateToken, http.MethodPost, publicationPath, publication(task, late, 3), http.StatusForbidden, "PROTECTED_ACCESS_DENIED", nil)
	const stale = "PROTECTED_STATE_UNAVAILABLE"
	request(readerToken, http.MethodPost, publicationPath, old, http.StatusServiceUnavailable, stale, nil)
	badTally := task
	badTally.Counts = []int{1, 0}
	request(readerToken, http.MethodPost, publicationPath, publication(badTally, reader, 2), http.StatusServiceUnavailable, stale, nil)
	countResults(0)
	valid := publication(task, reader, 2)
	request(readerToken, http.MethodPost, publicationPath, valid, http.StatusOK, "", nil)
	request(readerToken, http.MethodPost, publicationPath, valid, http.StatusOK, "", nil)
	countResults(1)
	request(readerToken, http.MethodPost, publicationPath, publication(badTally, reader, 2), http.StatusConflict, "PROTECTED_ROTATION_UNAVAILABLE", nil)
	if remaining := tasks(readerToken); len(remaining) != 0 {
		t.Fatalf("published result remained pending: %+v", remaining)
	}

	historyPath := "/history/live/" + channel + "?after=0&limit=8"
	var visible, hidden access.LiveMessagePage
	request(readerToken, http.MethodGet, historyPath, nil, http.StatusOK, "", &visible)
	request(lateToken, http.MethodGet, historyPath, nil, http.StatusOK, "", &hidden)
	if len(visible.Messages) != 2 || visible.Messages[0].Position != receipt.Position || visible.Messages[0].Packet.Poll == nil ||
		len(hidden.Messages) != 0 || hidden.First <= receipt.Position {
		t.Fatalf("history boundaries do not match poll and result: visible=%+v hidden=%+v", visible, hidden)
	}
	published := visible.Messages[1]
	result := published.PollResult
	if result == nil || published.Position <= receipt.Position || result.Original != receipt.Position ||
		result.SourceDigest != task.SourceDigest || result.ClosedAt != deadline || result.Total != task.Total || !slices.Equal(result.Counts, task.Counts) {
		t.Fatalf("incorrect published system result: %+v", published)
	}
	frame, err := signatureFrame("pawtalk-poll-result-v1", serverID, channel, strconv.FormatUint(published.Position, 10),
		strconv.FormatUint(result.Original, 10), result.SourceDigest, strconv.FormatInt(result.ClosedAt, 10), "1", "0", "1")
	signature, decodeErr := b64.DecodeString(result.Signature)
	if err != nil || decodeErr != nil || !ed25519.Verify(serverKey, frame, signature) {
		t.Fatalf("publication is not signed as a server system result: %v, %v", err, decodeErr)
	}
}
