package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedVoiceUsesCurrentRuntimeSession(t *testing.T) {
	ctx := context.Background()
	legacy := testMembershipStore(t)
	now := time.Unix(50000, 0)
	native := os.Getenv("PAWTALK_TEST_PROTECTED_MEDIA") == "1"
	if native {
		now = time.Now()
	}
	legacy.now = func() time.Time { return now }
	channel := strings.Repeat("a", 32)
	_, _, owner, reader := protectedTestStateWith(t, legacy, func(state *access.State) {
		state.Channels[channel] = access.Channel{Kind: "voice", NextPosition: 1,
			Settings: &access.ChannelSettings{Name: "Voice", VoiceCapacity: 1}}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect"}}
	})
	draft, err := legacy.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, legacy, owner, 1, draft)); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.db.ExecContext(ctx, protectedSessionSchema+protectedVoiceKeySchema); err != nil {
		t.Fatal(err)
	}
	var serverID string
	if err := legacy.db.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	store := &membershipStore{db: legacy.db, now: legacy.now, protectedBinding: strings.Repeat("b", 64)}
	runtime := &protectedRuntime{store: store, serverID: serverID, cutoverDigest: strings.Repeat("d", 64), challenges: make(map[string]int64)}
	openSession := func(deviceID string, seed byte) protectedSessionReceipt {
		t.Helper()
		challenge, err := runtime.issueSessionChallenge()
		if err != nil {
			t.Fatal(err)
		}
		frame, err := signatureFrame("pawtalk-protected-session-v1", challenge.ServerID, challenge.CutoverDigest, challenge.Binding, challenge.Nonce, deviceID)
		if err != nil {
			t.Fatal(err)
		}
		signer := newTestMemberSigner(seed)
		session, err := runtime.openSession(ctx, protectedSessionRequest{
			DeviceID: deviceID, Nonce: challenge.Nonce, Signature: b64.EncodeToString(ed25519.Sign(signer.device, frame)),
		})
		if err != nil {
			t.Fatal(err)
		}
		return session
	}
	session := openSession(reader.Access.DeviceID, 2)
	signer := newTestMemberSigner(2)
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("c", 64)}
	if _, err := store.joinProtectedVoice(ctx, reader.Token, channel, cfg); err == nil || err.Error() != "INVALID_PROTECTED_SESSION" {
		t.Fatalf("runtime accepted a legacy bearer: %v", err)
	}
	if _, err := store.joinProtectedVoice(ctx, session.Token, channel, cfg); !errors.Is(err, access.ErrVoiceGrantChanged) {
		t.Fatalf("runtime granted media before accepting a voice key: %v", err)
	}
	if _, err := runtime.prepareVoiceSlot(ctx, session.Token, channel); err != nil {
		t.Fatal(err)
	}
	claim, err := runtime.claimVoiceKey(ctx, session.Token, channel)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.joinProtectedVoiceWithKey(ctx, session.Token, channel, claim.Basis.EpochID, cfg); !errors.Is(err, access.ErrVoiceGrantChanged) {
		t.Fatalf("an unpublished claim granted media: %v", err)
	}
	commitment := strings.Repeat("c", 64)
	keyFrame, err := protectedVoiceKeyFrame(claim.Basis, claim.Roster[0], commitment)
	if err != nil {
		t.Fatal(err)
	}
	offer := protectedVoiceKeyOffer{Basis: claim.Basis, Commitment: commitment, Signature: ed25519.Sign(signer.device, keyFrame),
		Packages: map[string][]byte{session.SessionID: bytes.Repeat([]byte{1}, access.EpochPackageSize)}}
	if err := runtime.publishVoiceKey(ctx, session.Token, channel, offer); err != nil {
		t.Fatal(err)
	}
	grant, err := store.joinProtectedVoiceWithKey(ctx, session.Token, channel, claim.Basis.EpochID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !grant.E2EERequired || grant.Identity != session.SessionID || grant.KeyEpoch != claim.Basis.EpochID {
		t.Fatal("grant was not scoped to the protected session with mandatory E2EE")
	}
	if err := store.heartbeatProtectedVoice(ctx, session.Token); err != nil {
		t.Fatal(err)
	}
	claims, err := verifyMediaGrant(cfg, grant.Token, store.now())
	if err != nil {
		t.Fatal(err)
	}
	if *claims.Video.CanPublish || !*claims.Video.CanSubscribe || claims.Attributes["pawtalk.voice-epoch"] != claim.Basis.EpochID {
		t.Fatal("Connect without Speak must issue listen-only media permissions")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rtc" {
			t.Errorf("unexpected upstream path %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	signal := func(mediaStore *membershipStore, token string, want int) {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/rtc/rtc", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		membershipMediaHandler(mediaStore, cfg, target).ServeHTTP(w, request)
		if w.Code != want {
			t.Fatalf("signaling returned %d, wanted %d", w.Code, want)
		}
	}
	signal(store, grant.Token, http.StatusNoContent)
	restarted := &membershipStore{db: legacy.db, now: legacy.now, protectedBinding: strings.Repeat("e", 64)}
	signal(restarted, grant.Token, http.StatusForbidden)
	legacyToken, err := signedMediaClaims(cfg, map[string]any{
		"iss": cfg.APIKey, "sub": reader.Access.SessionID, "exp": store.now().Add(time.Minute).Unix(),
		"video": map[string]any{"room": "pt-legacy", "roomJoin": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	signal(store, legacyToken, http.StatusForbidden)
	signal(legacy, legacyToken, http.StatusNoContent)
	if native {
		ownerSession := openSession(owner.Access.DeviceID, 1)
		verifyProtectedVoiceMedia(t, store, cfg, grant, false, []voiceMediaStep{{Disconnect: true}},
			func(ctx context.Context, media config, _ int) error {
				return banProtectedVoiceFixture(ctx, runtime, ownerSession, session, channel, claim.Basis.EpochID, media)
			})
		return
	}
	now = now.Add(30 * time.Second)
	if err := store.heartbeatProtectedVoice(ctx, session.Token); err != nil {
		t.Fatal(err)
	}
	now = now.Add(15 * time.Second)
	next, err := runtime.claimVoiceKey(ctx, session.Token, channel)
	if err != nil {
		t.Fatal(err)
	}
	if next.Basis.EpochID == claim.Basis.EpochID || next.Published || claim.Basis.ExpiresAt <= now.UnixMilli() ||
		next.Basis.ExpiresAt != now.Add(protectedVoiceKeyTTL).UnixMilli() {
		t.Fatalf("active media did not get an unpublished replacement before its key expired: now=%d old=%+v new=%+v",
			now.UnixMilli(), claim.Basis, next)
	}
	if _, err := store.db.ExecContext(ctx, "UPDATE protected_runtime_sessions SET expires_at=0 WHERE session_id=?", grant.Identity); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.claimVoiceKey(ctx, session.Token, channel); err == nil || err.Error() != "INVALID_PROTECTED_SESSION" {
		t.Fatalf("an expired session still claimed a key: %v", err)
	}
}

func banProtectedVoiceFixture(ctx context.Context, runtime *protectedRuntime, owner, target protectedSessionReceipt,
	channel, epoch string, media config) error {
	headRequest := httptest.NewRequest(http.MethodGet, "/api/v3/member/leave/head", nil).WithContext(ctx)
	headRequest.Header.Set("Authorization", "Bearer "+owner.Token)
	head := httptest.NewRecorder()
	runtime.departureHeadHTTP(head, headRequest)
	var current struct {
		PolicyHead string `json:"policyHead"`
	}
	if head.Code != http.StatusOK || json.Unmarshal(head.Body.Bytes(), &current) != nil || !validHexID(current.PolicyHead, 64) {
		return fmt.Errorf("read ban fixture policy head: HTTP %d", head.Code)
	}
	intent := protectedDepartureIntent{ProfileID: owner.ProfileID, DeviceID: owner.DeviceID,
		OperationID: strings.Repeat("9", 32), PolicyHead: current.PolicyHead, Target: target.ProfileID, Reason: "Fixture ban"}
	frame, err := signatureFrame("pawtalk-protected-member-moderation-v1", runtime.serverID, runtime.cutoverDigest,
		intent.ProfileID, intent.DeviceID, intent.OperationID, intent.PolicyHead, access.BanPolicyMember, intent.Target, intent.Reason, "0")
	if err != nil {
		return err
	}
	intent.Signature = b64.EncodeToString(ed25519.Sign(newTestMemberSigner(1).device, frame))
	body, err := json.Marshal(intent)
	if err != nil {
		return err
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v3/moderation/member/ban", bytes.NewReader(body)).WithContext(ctx)
	request.SetPathValue("action", "ban")
	request.Header.Set("Authorization", "Bearer "+owner.Token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	runtime.moderateMembershipHTTP(response, request)
	if response.Code != http.StatusOK {
		return fmt.Errorf("commit signed ban: HTTP %d, %s", response.Code, response.Body.String())
	}
	if _, err := runtime.store.joinProtectedVoiceWithKey(ctx, target.Token, channel, epoch, media); err == nil || err.Error() != "INVALID_PROTECTED_SESSION" {
		return fmt.Errorf("voice grant after ban: expected invalid session, got %v", err)
	}
	return runtime.store.reconcilePendingProtectedVoice(ctx, media)
}

func TestProtectedVoiceSignalRechecksGrant(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(50000, 0)
	server.now = func() time.Time { return now }
	channel := strings.Repeat("a", 32)
	_, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Channels[channel] = access.Channel{Kind: "voice", NextPosition: 1}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect", "voice.speak"}}
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
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("c", 64)}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Fixture-Media", r.URL.Path)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	media := membershipMediaHandler(server, cfg, target)
	signal := func(path, token, header string, want int) {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		if token != "" {
			query := request.URL.Query()
			query.Set("access_token", token)
			request.URL.RawQuery = query.Encode()
		}
		if header != "" {
			request.Header.Set("Authorization", "Bearer "+header)
		}
		w := httptest.NewRecorder()
		media.ServeHTTP(w, request)
		if w.Code != want {
			t.Fatalf("%s returned %d, expected %d", path, w.Code, want)
		}
		upstreamPath := w.Header().Get("X-Fixture-Media")
		if (want == http.StatusOK && upstreamPath != strings.TrimPrefix(path, "/rtc")) ||
			(want != http.StatusOK && upstreamPath != "") {
			t.Fatalf("unexpected media forwarding for %s: %q", path, upstreamPath)
		}
	}
	grant := func() memberVoice {
		t.Helper()
		result, err := server.joinProtectedVoice(ctx, reader.Token, channel, cfg)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	const v0, v1 = "/rtc/rtc", "/rtc/rtc/v1/validate"
	first := grant()
	signal(v0, first.Token, "", http.StatusOK)
	signal(v1, "", first.Token, http.StatusOK)
	signal(v0, first.Token, "different", http.StatusUnauthorized)
	signal(v0+"?publish=extra", first.Token, "", http.StatusForbidden)
	signal("/rtc/twirp/livekit.RoomService/GetParticipant", first.Token, "", http.StatusNotFound)
	signal(v0, "invalid", "", http.StatusUnauthorized)
	legacy, err := signedMediaClaims(cfg, map[string]any{
		"iss": cfg.APIKey, "sub": first.Identity, "exp": now.Add(time.Minute).Unix(),
		"video": map[string]any{"room": strings.Replace(first.Room, "ptp-", "pt-", 1), "roomJoin": true},
	})
	if err != nil {
		t.Fatal(err)
	}
	signal(v0, legacy, "", http.StatusOK)

	restriction := access.PolicyResourceChange{ID: channel, TargetProfileID: reader.Access.EffectiveProfileID}
	mute := func(id string) {
		commit(access.PolicyDraft{Action: access.ChangeVoiceMute, OperationID: strings.Repeat(id, 32), ResourceChange: &restriction})
	}
	mute("2")
	signal(v0, first.Token, "", http.StatusForbidden)
	restriction.Lift = true
	mute("3")
	signal(v0, first.Token, "", http.StatusForbidden)
	now = now.Add(time.Second)
	second := grant()
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect", "voice.speak", "channel.create"}}
	commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("4", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	signal(v1, second.Token, "", http.StatusOK)
	commit(access.PolicyDraft{Action: access.EditPolicyChannel, OperationID: strings.Repeat("5", 32),
		ResourceChange: &access.PolicyResourceChange{ID: channel, Settings: &access.ChannelSettings{Name: "Voice", VoiceCapacity: 2}}})
	signal(v1, second.Token, "", http.StatusForbidden)
	now = now.Add(time.Second)
	third := grant()
	signal(v0, third.Token, "", http.StatusOK)
	now = now.Add(time.Second)
	fourth := grant()
	signal(v1, third.Token, "", http.StatusForbidden)
	signal(v0, fourth.Token, "", http.StatusOK)
	if _, _, err := server.leaveProtectedVoice(ctx, reader.Token); err != nil {
		t.Fatal(err)
	}
	signal(v0, fourth.Token, "", http.StatusForbidden)
	if _, err := server.joinProtectedVoice(ctx, reader.Token, channel, cfg); !errors.Is(err, access.ErrVoiceOccupied) {
		t.Fatalf("new join raced queued removal of the same identity: %v", err)
	}
	cfg.PresenceURL = upstream.URL
	if err := server.reconcilePendingProtectedVoice(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	fresh := grant()
	if fresh.Token == fourth.Token {
		t.Fatal("new grant reused a departed session's token")
	}
	signal(v0, fourth.Token, "", http.StatusForbidden)
	signal(v0, fresh.Token, "", http.StatusOK)
	now = now.Add(protectedVoiceLease)
	signal(v0, fresh.Token, "", http.StatusUnauthorized)
	if _, err := server.joinProtectedVoice(ctx, reader.Token, channel, cfg); !errors.Is(err, access.ErrVoiceOccupied) {
		t.Fatalf("expired slot was reused before disconnect: %v", err)
	}
	if err := server.reconcilePendingProtectedVoice(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	current := grant()
	if _, err := server.db.Exec("UPDATE sessions SET revoked_at=? WHERE session_id=?", now.UnixMilli(), current.Identity); err != nil {
		t.Fatal(err)
	}
	signal(v0, current.Token, "", http.StatusForbidden)
}
