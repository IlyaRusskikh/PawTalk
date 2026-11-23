package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedBanCleanupKeepsBanAndRollsBackPartialDeletion(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(1_800_000_000, 0)
	server.now = func() time.Time { return now }
	visible, hidden, protectedPoll := strings.Repeat("a", 32), strings.Repeat("b", 32), strings.Repeat("f", 32)
	var target memberSession
	store, _, owner, moderator := protectedTestStateWith(t, server, func(state *access.State) {
		signer := newTestMemberSigner(3)
		activateTestMember(t, server, signer, "member")
		target = loginTestMember(t, server, signer)
		profile, device := target.Access.EffectiveProfileID, target.Access.DeviceID
		state.Members[profile] = access.Subject{ID: profile, Active: true}
		state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 33)}
		state.Roles[access.Everyone] = access.Role{Grants: []string{access.ChannelView, "message.send", "poll.create"}}
		state.Roles["reader"] = access.Role{Grants: []string{access.BanPolicyMember, access.KickPolicyMember, "history.full",
			"message.delete-other", "poll.delete-completed", "audit.view"}}
		var moderatorProfile string
		for _, member := range state.Members {
			if len(member.Roles) != 0 {
				moderatorProfile = member.ID
				break
			}
		}
		delete(state.Channels, "private")
		state.Channels[visible] = access.Channel{Kind: "text", NextPosition: 1}
		state.Channels[hidden] = access.Channel{Kind: "text", NextPosition: 1, ACL: access.ACL{
			Profiles: map[string]access.Overwrite{moderatorProfile: {Deny: []string{access.ChannelView}}},
		}}
		state.Channels[protectedPoll] = access.Channel{Kind: "text", NextPosition: 1, ACL: access.ACL{
			Profiles: map[string]access.Overwrite{moderatorProfile: {Deny: []string{"poll.delete-completed"}}},
		}}
	})
	anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
	moderatorToken, targetToken := open(moderator, 2), open(target, 3)
	owner.Token, target.Token = open(owner, 1), targetToken
	epochs := make(map[string]access.EpochRecord)
	for _, channel := range []string{visible, hidden, protectedPoll} {
		epoch, packages := prepareTestEpoch(t, server, owner, 1, channel, strings.Repeat(string(channel[0]), 64))
		if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
			t.Fatal(err)
		}
		epochs[channel] = epoch
	}
	appendText := func(channel string, operation byte, poll *access.MessagePoll) uint64 {
		t.Helper()
		packet := signProtectedTestMessage(t, server, target, 3, access.MessageAttempt{ChannelID: channel, KeyID: epochs[channel].KeyID,
			OperationID: fmt.Sprintf("%032x", operation), Nonce: bytes.Repeat([]byte{operation}, 12),
			Ciphertext: make([]byte, 17), Poll: poll})
		receipt, err := server.appendProtectedMessage(ctx, target.Token, packet)
		if err != nil {
			t.Fatal(err)
		}
		return receipt.Position
	}
	ordinary := appendText(visible, 1, nil)
	poll := appendText(visible, 2, &access.MessagePoll{Duration: 3600, OptionCount: 2})
	hiddenPosition := appendText(hidden, 3, nil)
	pinnedPoll := appendText(protectedPoll, 4, &access.MessagePoll{Duration: 3600, OptionCount: 2})
	ownerSession := server.protectedSession(owner.Token)
	if err := store.SetMessagePin(ctx, ownerSession, hidden, hiddenPosition, true, false); err != nil {
		t.Fatal(err)
	}
	for channel, position := range map[string]uint64{visible: poll, protectedPoll: pinnedPoll} {
		if err := store.ClosePoll(ctx, ownerSession, nil, channel, position); err != nil {
			t.Fatal(err)
		}
		if err := store.PublishPollResult(ctx, channel, position, false, signProtectedPollResult); err != nil {
			t.Fatal(err)
		}
	}
	var result uint64
	if err := server.db.QueryRowContext(ctx, "SELECT position FROM protected_poll_results WHERE channel_id=? AND original_position=?",
		visible, poll).Scan(&result); err != nil || result <= poll {
		t.Fatalf("closed poll has no signed result position: %d, %v", result, err)
	}
	encode := func(value any) []byte {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	targetProfile := target.Access.EffectiveProfileID
	call(http.MethodGet, "/api/v3/history/live/"+hidden, moderatorToken, nil, http.StatusForbidden)
	previewBody := call(http.MethodPost, "/api/v3/moderation/cleanup/preview", moderatorToken,
		encode(map[string]string{"target": targetProfile, "action": "ban", "window": "all"}), http.StatusOK)
	var preview access.ModerationCleanupPreview
	var fields map[string]json.RawMessage
	if json.Unmarshal(previewBody, &preview) != nil || json.Unmarshal(previewBody, &fields) != nil ||
		preview.Count != 3 || len(fields) != 2 || !validHexID(preview.ID, 32) || bytes.Contains(previewBody, []byte(hidden)) {
		t.Fatalf("preview did not report the visible message and poll pair safely: %s", previewBody)
	}
	const reason = "Synthetic confirmed ban"
	actor := access.Principal{ProfileID: moderator.Access.EffectiveProfileID, DeviceID: moderator.Access.DeviceID}
	operation, expires := strings.Repeat("c", 32), now.Add(time.Hour).UnixMilli()
	moderation := func(action, reason string, expires int64) protectedDepartureIntent {
		t.Helper()
		frame, err := signatureFrame("pawtalk-protected-member-moderation-v1", runtime.serverID, runtime.cutoverDigest,
			actor.ProfileID, actor.DeviceID, operation, anchor.Digest, action, targetProfile, reason, strconv.FormatInt(expires, 10))
		if err != nil {
			t.Fatal(err)
		}
		return protectedDepartureIntent{ProfileID: actor.ProfileID, DeviceID: actor.DeviceID, Target: targetProfile, Reason: reason,
			OperationID: operation, PolicyHead: anchor.Digest, ExpiresAt: expires,
			Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(2).device, frame))}
	}
	call(http.MethodPost, "/api/v3/moderation/member/kick", moderatorToken,
		encode(moderation(access.KickPolicyMember, "", 0)), http.StatusBadRequest)
	call(http.MethodPost, "/api/v3/moderation/member/ban", moderatorToken,
		encode(moderation(access.BanPolicyMember, "", expires)), http.StatusBadRequest)
	call(http.MethodGet, "/api/v3/state", targetToken, nil, http.StatusOK)
	call(http.MethodPost, "/api/v3/moderation/member/ban", moderatorToken,
		encode(moderation(access.BanPolicyMember, reason, expires)), http.StatusOK)
	challenge, err := runtime.issueSessionChallenge()
	if err != nil {
		t.Fatal(err)
	}
	frame, err := signatureFrame("pawtalk-protected-session-v1", runtime.serverID, runtime.cutoverDigest,
		server.protectedBinding, challenge.Nonce, target.Access.DeviceID)
	if err != nil {
		t.Fatal(err)
	}
	login := protectedSessionRequest{DeviceID: target.Access.DeviceID, Nonce: challenge.Nonce,
		Signature: b64.EncodeToString(ed25519.Sign(newTestMemberSigner(3).device, frame))}
	var denial struct {
		Error struct {
			Code    string
			Details struct {
				Reason          string
				ModerationScope string
				ExpiresAt       int64
			}
		}
	}
	raw := call(http.MethodPost, "/api/v3/session/open", "", encode(login), http.StatusForbidden)
	if json.Unmarshal(raw, &denial) != nil || denial.Error.Code != "BANNED" || denial.Error.Details.Reason != reason ||
		denial.Error.Details.ModerationScope != "server" || denial.Error.Details.ExpiresAt != expires {
		t.Fatalf("banned target did not receive the exact reason, scope and deadline: %s", raw)
	}
	requireBanned := func() {
		t.Helper()
		call(http.MethodGet, "/api/v3/state", targetToken, nil, http.StatusUnauthorized)
		var bans access.MemberBanPage
		raw := call(http.MethodGet, "/api/v3/moderation/bans", moderatorToken, nil, http.StatusOK)
		if json.Unmarshal(raw, &bans) != nil || len(bans.Bans) != 1 || bans.Bans[0].ProfileID != targetProfile ||
			bans.Bans[0].Reason != reason || bans.Bans[0].ExpiresAt != expires {
			t.Fatalf("independent signed ban missing: %s", raw)
		}
	}
	count := func(query, channel string) int {
		t.Helper()
		var count int
		if err := server.db.QueryRowContext(ctx, query, channel).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	const messages = "SELECT count(*) FROM protected_messages WHERE channel_id=?"
	const deletions = "SELECT count(*) FROM protected_message_deletions WHERE channel_id=?"
	requireBanned()
	if count(messages, visible) != 2 || count(messages, hidden) != 1 || count(deletions, visible) != 0 {
		t.Fatal("ban committed unconfirmed deletion")
	}
	// Fail after the ordinary message is visited, during completed-poll cleanup.
	if _, err := server.db.ExecContext(ctx, fmt.Sprintf(`CREATE TRIGGER fail_confirmed_cleanup BEFORE DELETE ON protected_messages
		WHEN OLD.channel_id='%s' AND OLD.position=%d BEGIN SELECT RAISE(ABORT,'synthetic cleanup fault'); END`, visible, poll)); err != nil {
		t.Fatal(err)
	}
	apply := encode(map[string]string{"id": preview.ID, "operationId": operation})
	failed := call(http.MethodPost, "/api/v3/moderation/cleanup/apply", moderatorToken, apply, http.StatusInternalServerError)
	if bytes.Contains(failed, []byte(hidden)) || bytes.Contains(failed, []byte("synthetic cleanup fault")) {
		t.Fatalf("failed cleanup exposed hidden or internal details: %s", failed)
	}
	requireBanned()
	if count(messages, visible) != 2 || count(messages, hidden) != 1 || count(deletions, visible) != 0 ||
		count("SELECT count(*) FROM protected_audit_events WHERE channel_id=? AND action IN ('message.delete','poll.delete-completed')", visible) != 0 {
		t.Fatal("failed cleanup committed a partial deletion or audit event")
	}
	if _, err := server.db.ExecContext(ctx, "DROP TRIGGER fail_confirmed_cleanup"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if raw := call(http.MethodPost, "/api/v3/moderation/cleanup/apply", moderatorToken, apply, http.StatusOK); strings.TrimSpace(string(raw)) != `{"removed":3}` {
			t.Fatalf("confirmed cleanup did not return the exact stable count: %s", raw)
		}
	}
	requireBanned()
	if count(messages, visible) != 0 || count(messages, hidden) != 1 || count(deletions, hidden) != 0 ||
		count(deletions, visible) != 3 || count(messages, protectedPoll) != 1 ||
		count("SELECT count(*) FROM protected_poll_results WHERE channel_id=? AND record!=''", protectedPoll) != 1 ||
		count("SELECT count(*) FROM protected_poll_results WHERE channel_id=? AND record!=''", visible) != 0 {
		t.Fatal("confirmed cleanup failed to preserve inaccessible content or remove exactly the authorized poll pair")
	}
	var audit access.AuditPage
	auditBody := call(http.MethodGet, "/api/v3/audit", moderatorToken, nil, http.StatusOK)
	if json.Unmarshal(auditBody, &audit) != nil || bytes.Contains(auditBody, []byte(hidden)) {
		t.Fatalf("moderator audit exposed the hidden channel: %s", auditBody)
	}
	required := map[string]uint64{access.BanPolicyMember: 0, "message.delete": ordinary, "poll.delete-completed": poll}
	for _, event := range audit.Entries {
		if position, ok := required[event.Action]; ok && event.Actor == actor.ProfileID && event.Position == position {
			delete(required, event.Action)
		}
	}
	if len(required) != 0 {
		t.Fatalf("missing moderation audit entries: %v", required)
	}
}
