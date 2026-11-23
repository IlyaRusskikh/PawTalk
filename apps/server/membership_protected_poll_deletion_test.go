package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedImportedPollVotingAndDeletion(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	var clock atomic.Int64
	clock.Store(time.Now().UnixMilli())
	server.now = func() time.Time { return time.UnixMilli(clock.Load()) }
	var channel string
	store, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		if err := server.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_text'").Scan(&channel); err != nil {
			t.Fatal(err)
		}
		state.Channels = map[string]access.Channel{channel: {Kind: "text", NextPosition: 3}}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "history.full", "poll.vote", "message.delete-other"}}
		for profile, subject := range state.Members {
			if profile != state.Owner {
				subject.TimeoutUntil = clock.Load() + 1000
				state.Members[profile] = subject
			}
		}
	})
	insertMigrationCiphertextFixture(t, server, owner.Access, false)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := server.db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	const pollID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	deadline := clock.Load() + 5000
	exec(`INSERT INTO polls(poll_id,message_id,option_count,multiple,anonymous,intermediate,closes_at,closed_at,
		result_message_id,result_request_id,result_nonce,result_ciphertext,create_hash)
		SELECT ?,a.message_id,2,0,1,0,?,NULL,NULL,?,b.nonce,b.ciphertext,zeroblob(32)
		FROM messages a JOIN messages b ON a.channel_id=b.channel_id WHERE a.message_id<b.message_id`,
		pollID, deadline, strings.Repeat("b", 32))
	exec("INSERT INTO poll_votes(poll_id,profile_id,choices,updated_at) VALUES(?,?,'[0]',?)",
		pollID, reader.Access.EffectiveProfileID, clock.Load())
	exec(migrationImportSchema)
	exec("CREATE TABLE protected_migration_source(id INTEGER PRIMARY KEY,backup_archive_sha256 TEXT NOT NULL)")
	exec("INSERT INTO protected_migration_source VALUES(1,?)", strings.Repeat("a", 64))
	exec(`CREATE TABLE protected_migration_message_positions AS
		SELECT channel_id,message_id,ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY message_id) AS position FROM messages`)
	exec("INSERT INTO protected_migration_channel_keys SELECT DISTINCT channel_id,crypto_context_id FROM messages")
	exec(`INSERT INTO protected_migration_records
		SELECT 'messages',CAST(message_id AS TEXT),channel_id,crypto_context_id,'{}','',nonce,ciphertext,'',author_device_id,zeroblob(64)
		FROM messages`)
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	positions, err := importedCleanupPositions(ctx, tx, channel, owner.Access.EffectiveProfileID, 1, 0, clock.Load(), 128)
	tx.Rollback()
	if err != nil || len(positions) != 1 || positions[0] != 2 {
		t.Fatalf("imported cleanup positions: %v, %v", positions, err)
	}
	// Seed a mixed interval before anchoring to exercise an admission
	// between a question and its result within the imported position space.
	exec("UPDATE protected_policy SET snapshot=CAST(json_set(snapshot,?,2) AS BLOB) WHERE id=1",
		"$.Admissions."+channel+"."+reader.Access.EffectiveProfileID+".FirstPosition")
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
	ownerSession, readerSession := server.protectedSession(owner.Token), server.protectedSession(reader.Token)
	rawToken := make([]byte, 32)
	tokenHash := sha256.Sum256(rawToken)
	binding := strings.Repeat("c", 64)
	exec(protectedSessionSchema)
	exec(`INSERT INTO protected_runtime_sessions(session_id,device_id,token_hash,binding,expires_at) VALUES(?,?,?,?,?)`,
		strings.Repeat("3", 32), reader.Access.DeviceID, tokenHash[:], binding, server.now().Add(time.Hour).UnixMilli())
	runtime := &protectedRuntime{
		store:                &membershipStore{db: server.db, now: server.now, protectedBinding: binding},
		importedProfileNames: map[string]string{owner.Access.EffectiveProfileID: "Poll owner", reader.Access.EffectiveProfileID: "Poll reader"},
	}
	room := httptest.NewTLSServer(runtime.handler())
	defer room.Close()
	request := func(method, position, body, wantCode, wantBody string) []byte {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, room.URL+"/api/v3/history/poll/"+channel+"/"+position, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+b64.EncodeToString(rawToken))
		req.Header.Set("Content-Type", "application/json")
		res, err := room.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		reply, err := io.ReadAll(res.Body)
		if err != nil || res.Status != wantCode || !strings.Contains(string(reply), wantBody) {
			t.Fatalf("poll status = %s, body = %s, error = %v", res.Status, reply, err)
		}
		return reply
	}
	readPoll := func() access.PollState {
		t.Helper()
		reply := request(http.MethodGet, "1", "", "200 OK", "")
		var poll access.PollState
		if err := json.Unmarshal(reply, &poll); err != nil || strings.Contains(string(reply), `"voters"`) {
			t.Fatalf("anonymous vote details leaked: %s, %v", reply, err)
		}
		return poll
	}
	vote := func(operation, choices, code, expected string) {
		t.Helper()
		request(http.MethodPut, "1", `{"operationId":"`+strings.Repeat(operation, 32)+`","choices":`+choices+`}`, code, expected)
	}
	if poll := readPoll(); poll.CanVote || len(poll.Counts) != 0 || len(poll.Own) != 1 || poll.Own[0] != 0 {
		t.Fatalf("frozen ballot state during timeout: %+v", poll)
	}
	vote("4", "[1]", "403 Forbidden", "PROTECTED_TIMED_OUT")
	clock.Add(1000)
	vote("4", "[1]", "200 OK", `"ok":true`)
	vote("5", "[]", "200 OK", `"ok":true`)
	vote("4", "[1]", "200 OK", `"ok":true`)
	if poll := readPoll(); !poll.CanVote || poll.Total != 0 || len(poll.Own) != 0 || len(poll.Counts) != 0 {
		t.Fatalf("retry overrode the withdrawal: %+v", poll)
	}
	vote("6", "[0]", "200 OK", `"ok":true`)
	request(http.MethodPut, "1/close", "", "403 Forbidden", "PROTECTED_ACCESS_DENIED")
	clock.Store(deadline)
	vote("7", "[1]", "409 Conflict", "POLL_CLOSED")
	if poll := readPoll(); poll.CanVote || poll.ClosedAt == nil || *poll.ClosedAt != deadline || len(poll.Counts) != 2 || poll.Counts[0] != 1 {
		t.Fatalf("incorrect result at the deadline: %+v", poll)
	}
	if err := store.FreezeExpiredPolls(ctx, resolveImportedPoll); err != nil {
		t.Fatal(err)
	}
	var frozenAt int64
	var counts string
	if err := server.db.QueryRow("SELECT closed_at,counts FROM protected_poll_closures WHERE channel_id=? AND position=1",
		channel).Scan(&frozenAt, &counts); err != nil || frozenAt != deadline || counts != "[1,0]" {
		t.Fatalf("scheduler did not save the imported tally: %d %q %v", frozenAt, counts, err)
	}
	exec("UPDATE polls SET closed_at=?,result_message_id=(SELECT MAX(message_id) FROM messages) WHERE poll_id=?", deadline, pollID)
	for _, position := range []uint64{1, 2} {
		if err := store.SetMessagePin(ctx, ownerSession, channel, position, true, true); err != nil {
			t.Fatal(err)
		}
		if err := store.DeleteMessage(ctx, ownerSession, resolveImportedProtectedMessage, channel, position); !errors.Is(err, access.ErrMessageKind) {
			t.Fatalf("ordinary deletion accepted protected poll position %d: %v", position, err)
		}
	}
	readImported := func(resolve access.ResolveSession, after uint64, expectedFirst uint64, want int) {
		t.Helper()
		err := server.dispatchImportedProtectedHistory(ctx, resolve, channel, after, 1, func(page importedProtectedPage) error {
			if page.First != expectedFirst || len(page.Messages) != want {
				t.Fatalf("unexpected result delivery: %+v", page)
			}
			if want == 1 && (page.Messages[0].Position != 2 || page.Messages[0].OriginalPoll != 1) {
				t.Fatalf("result lost its original position: %+v", page.Messages[0])
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	// A continuation after the question still delivers the result when the
	// question is inside the reader's real window.
	readImported(readerSession, 1, 1, 1)
	fullHistory := state.Roles["reader"]
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "audit.view", "message.pin", "message.send"}}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("c", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	readImported(readerSession, 1, 2, 0)
	if err := store.DispatchHistory(ctx, readerSession, channel, func(conn *sql.Conn, first, next uint64) error {
		references, err := readImportedMessageReferences(ctx, conn, channel, first, next, []int64{9007199254740994}, true)
		if err == nil && len(references) != 0 {
			t.Fatalf("direct legacy ID revealed a result: %+v", references)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetMessagePin(ctx, readerSession, channel, 2, true, true); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("pin accepted a result outside original history: %v", err)
	}
	replyOperation, salt := strings.Repeat("c", 32), strings.Repeat("d", 64)
	replyDigest := sha256.Sum256([]byte("pawtalk-protected-reply-v1:" + replyOperation + ":2:" + salt))
	reply := access.MessageAttempt{ChannelID: channel, OperationID: replyOperation, KeyID: strings.Repeat("1", 64),
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64),
		Reply: &access.MessageReply{Position: 2, Salt: salt}, ReplyDigest: hex.EncodeToString(replyDigest[:])}
	verify := func(context.Context, access.SessionQuery, access.Principal, int64, access.MessageAttempt) error {
		return nil
	}
	if _, err := store.AppendMessage(ctx, readerSession, verify, reply, true); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("reply accepted a result outside original history: %v", err)
	}
	if err := store.DispatchPinnedMessages(ctx, readerSession, channel, true, 0, func(page access.PinnedMessagesPage) error {
		if !page.CanPin || len(page.Items) != 0 {
			t.Fatalf("pin list disclosed a hidden result: %+v", page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.DispatchAudit(ctx, readerSession, "", true, func(page access.AuditPage) error {
		for _, entry := range page.Entries {
			if entry.ChannelID == channel && entry.Position != 0 {
				t.Fatalf("audit disclosed a hidden poll or result: %+v", entry)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	state.Roles["reader"] = fullHistory
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("d", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	remove := func(position uint64) error {
		return store.DeleteCompletedPoll(ctx, readerSession, resolveImportedCompletedPoll, channel, position)
	}
	request(http.MethodDelete, "1", "", "403 Forbidden", "PROTECTED_ACCESS_DENIED")
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "history.full", "poll.delete-completed", "poll.close-other"}}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("2", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	if err := remove(2); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("the result cannot be removed on its own: %v", err)
	}
	exec(`CREATE TRIGGER reject_result_removal BEFORE INSERT ON protected_message_deletions
		WHEN NEW.position=2 BEGIN SELECT RAISE(ABORT,'synthetic result removal failure'); END`)
	if err := remove(1); err == nil || !strings.Contains(err.Error(), "synthetic result removal failure") {
		t.Fatalf("expected rollback when removing the result: %v", err)
	}
	var deleted int
	if err := server.db.QueryRow("SELECT COUNT(*) FROM protected_message_deletions").Scan(&deleted); err != nil || deleted != 0 {
		t.Fatalf("failure left a partial deletion: %d, %v", deleted, err)
	}
	exec("DROP TRIGGER reject_result_removal")
	request(http.MethodDelete, "1", "", "200 OK", `"ok":true`)
	request(http.MethodDelete, "1", "", "200 OK", `"ok":true`)
	request(http.MethodGet, "1", "", "403 Forbidden", "PROTECTED_ACCESS_DENIED")
	cursor := ""
	if err := store.DispatchHistoryWindow(ctx, readerSession, channel, &cursor, true, func(window access.HistoryWindow) error {
		if len(window.Removed) != 2 || window.Removed[0] != 1 || window.Removed[1] != 2 || len(window.Pins.Items) != 0 ||
			!window.CanDeletePoll || window.CanDeleteOther || window.CanSend {
			t.Fatalf("invalid deletion window: %+v", window)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "poll.delete-completed", "poll.close-other", "poll.vote"}}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("e", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	if err := store.DispatchHistoryWindow(ctx, readerSession, channel, &cursor, true, func(window access.HistoryWindow) error {
		if window.First != 2 || len(window.Removed) != 0 || window.Cursor != "" {
			t.Fatalf("timeline disclosed removed result outside original history: %+v", window)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var entries, source int
	if err := server.db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE action='poll.delete-completed' AND position=1").Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("dedicated action did not leave one audit entry: %d, %v", entries, err)
	}
	if err := server.db.QueryRow("SELECT COUNT(*) FROM messages").Scan(&source); err != nil || source != 2 {
		t.Fatalf("frozen source was changed: %d, %v", source, err)
	}
	native := access.MessageAttempt{ChannelID: channel, OperationID: strings.Repeat("9", 32), KeyID: strings.Repeat("1", 64),
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64),
		Poll: &access.MessagePoll{OptionCount: 2, Duration: 3600}}
	created, err := store.AppendMessage(ctx, ownerSession, verify, native, false)
	if err != nil || created.Position != 3 {
		t.Fatalf("native poll creation: %+v, %v", created, err)
	}
	if err := remove(3); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("completed poll deletion accepted an open poll: %v", err)
	}
	request(http.MethodPut, "3", `{"operationId":"`+strings.Repeat("0", 32)+`","choices":[1]}`, "200 OK", `"ok":true`)
	pending := request(http.MethodGet, "3", "", "200 OK", `"counts":[]`)
	if strings.Contains(string(pending), `"voters"`) {
		t.Fatalf("public voter appeared before tally visibility: %s", pending)
	}
	request(http.MethodPut, "3/close", "", "200 OK", `"ok":true`)
	request(http.MethodPut, "3/close", "", "200 OK", `"ok":true`)
	request(http.MethodGet, "3", "", "200 OK", `"name":"Poll reader"`)
	if err := store.PublishPollResult(ctx, channel, 3, true, signProtectedPollResult); err != nil {
		t.Fatal(err)
	}
	moderator := state.Roles["reader"]
	state.Roles["reader"] = access.Role{}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("a", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	if err := store.DispatchPoll(ctx, ownerSession, nil, channel, 3, func(poll access.PollState) error {
		if poll.Total != 1 || poll.Counts[1] != 1 || len(poll.Voters[1]) != 0 {
			t.Fatalf("revoking voter visibility changed or exposed the tally: %+v", poll)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	state.Roles["reader"] = access.Role{Grants: append(moderator.Grants, "history.full")}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("b", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	if err := server.db.QueryRow("SELECT COUNT(*) FROM protected_poll_results WHERE channel_id=? AND original_position=3 AND position=4",
		channel).Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("fixture did not publish exactly one closed poll result: %d, %v", entries, err)
	}
	if err := store.VotePoll(ctx, ownerSession, nil, channel, 3, strings.Repeat("8", 32), []int{0}); !errors.Is(err, access.ErrPollClosed) {
		t.Fatalf("vote after early close: %v", err)
	}
	if err := store.DeleteMessage(ctx, ownerSession, nil, channel, 3); !errors.Is(err, access.ErrMessageKind) {
		t.Fatalf("ordinary deletion accepted a closed native poll: %v", err)
	}
	if err := remove(3); err != nil {
		t.Fatalf("dedicated deletion of a completed native poll: %v", err)
	}
	if err := remove(3); err != nil {
		t.Fatalf("retry of native poll deletion: %v", err)
	}
	if err := server.db.QueryRow("SELECT COUNT(*) FROM protected_message_deletions WHERE channel_id=? AND position IN (3,4)",
		channel).Scan(&entries); err != nil || entries != 2 {
		t.Fatalf("native result did not share the poll deletion: %d, %v", entries, err)
	}
	if err := server.db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE action='poll.close' AND position=3").
		Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("early closure did not leave exactly one audit entry: %d, %v", entries, err)
	}
	native.OperationID, native.Nonce[0] = strings.Repeat("a", 32), 1
	if second, err := store.AppendMessage(ctx, ownerSession, verify, native, false); err != nil || second.Position != 5 {
		t.Fatalf("second open poll: %+v %v", second, err)
	}
	state.Roles["reader"] = access.Role{}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("8", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "message.pin"}}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("9", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	clock.Add(3600000)
	for range 2 {
		if err := store.FreezeExpiredPolls(ctx, resolveImportedPoll); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.db.QueryRow("SELECT closed_at,counts FROM protected_poll_closures WHERE channel_id=? AND position=5",
		channel).Scan(&frozenAt, &counts); err != nil || frozenAt != clock.Load() || counts != "[0,0]" {
		t.Fatalf("scheduler did not save the native tally: %d %q %v", frozenAt, counts, err)
	}
	clock.Add(-1000)
	restarted := access.NewStoreWithClock(server.db, server.now)
	if err := restarted.VotePoll(ctx, ownerSession, nil, channel, 5, strings.Repeat("b", 32), []int{0}); !errors.Is(err, access.ErrPollClosed) {
		t.Fatalf("scheduled closure did not survive a clock rollback: %v", err)
	}
	for range 2 {
		if err := restarted.PublishPollResults(ctx, true, signProtectedPollResult); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.db.QueryRow("SELECT COUNT(*) FROM protected_poll_results WHERE channel_id=? AND original_position=5 AND position=6",
		channel).Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("a saved closure did not publish once after restarting: %d, %v", entries, err)
	}
	if err := restarted.DispatchLiveMessages(ctx, readerSession, channel, 5, 1, nil, true, func(page access.LiveMessagePage) error {
		if page.First != 6 || len(page.Messages) != 0 {
			t.Fatalf("result widened a new reader's history: %+v", page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := restarted.SetMessagePin(ctx, readerSession, channel, 6, true, true); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("pin accepted a native result with an unavailable question: %v", err)
	}
	if err := restarted.DispatchLiveMessages(ctx, ownerSession, channel, 5, 1, nil, true, func(page access.LiveMessagePage) error {
		if len(page.Messages) != 1 || page.Messages[0].PollResult == nil || page.Messages[0].PollResult.Signature == "" {
			t.Fatalf("authorized continuation could not see a signed result: %+v", page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
