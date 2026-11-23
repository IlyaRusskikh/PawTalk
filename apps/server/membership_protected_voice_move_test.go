package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedVoiceMove(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(30000, 0)
	native := os.Getenv("PAWTALK_TEST_PROTECTED_MEDIA") == "1"
	if native {
		now = time.Now().UTC()
	}
	server.now = func() time.Time { return now }
	source, destination := strings.Repeat("a", 32), strings.Repeat("b", 32)
	closed, full := strings.Repeat("c", 32), strings.Repeat("d", 32)
	destinationACL := access.ACL{Roles: map[string]access.Overwrite{
		"reader": {Deny: []string{"voice.speak", "voice.move"}}, "moderator": {Deny: []string{"voice.move"}},
	}}
	closedACL := access.ACL{Roles: map[string]access.Overwrite{
		"reader": {Deny: []string{access.ChannelView}}, "moderator": {Deny: []string{access.ChannelView}},
	}}
	var moderator memberSession
	_, _, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		signer := newTestMemberSigner(3)
		activateTestMember(t, server, signer, "member")
		moderator = loginTestMember(t, server, signer)
		profile := moderator.Access.EffectiveProfileID
		state.Roles["moderator"] = access.Role{Grants: []string{access.ChannelView, "voice.connect", "voice.move"}}
		state.Order = append(state.Order, "moderator")
		state.Members[profile] = access.Subject{ID: profile, Active: true, Roles: []string{"moderator"}}
		state.PolicyDevices[moderator.Access.DeviceID] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect", "voice.speak", "voice.move"}}
		for id, acl := range map[string]access.ACL{source: {}, destination: destinationACL, closed: closedACL, full: {}} {
			state.Channels[id] = access.Channel{Kind: "voice", NextPosition: 1, ACL: acl,
				Settings: &access.ChannelSettings{Name: "Voice", VoiceCapacity: 1}}
		}
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
	original, err := server.joinProtectedVoice(ctx, reader.Token, source, cfg)
	if err != nil {
		t.Fatal(err)
	}
	profile := reader.Access.EffectiveProfileID
	if native {
		verifyProtectedVoiceMedia(t, server, cfg, original, true, []voiceMediaStep{{Disconnect: true}},
			func(ctx context.Context, media config, _ int) error {
				if err := server.planProtectedVoiceMove(ctx, media, owner.Token, profile, source, destination); err != nil {
					return err
				}
				return server.applyProtectedVoiceMove(ctx, media, profile)
			})
		ready, err := server.readyProtectedVoiceMove(ctx, reader.Token)
		if err != nil || ready != destination {
			t.Fatalf("source disconnected with no ready destination: %q, %v", ready, err)
		}
		grant, err := server.joinProtectedVoice(ctx, reader.Token, destination, cfg)
		if err != nil {
			t.Fatal(err)
		}
		verifyProtectedVoiceMedia(t, server, cfg, grant, false, nil, nil)
		return
	}
	var aware, failRemove atomic.Bool
	var expectedRoom atomic.Value
	expectedRoom.Store(original.Room)
	var removed atomic.Int32
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var target struct{ Room, Identity string }
		if err := json.NewDecoder(r.Body).Decode(&target); err != nil {
			http.Error(w, "invalid fixture request", http.StatusBadRequest)
			return
		}
		if target.Room != expectedRoom.Load() || target.Identity != original.Identity {
			http.Error(w, "unexpected voice target", http.StatusBadRequest)
			return
		}
		switch r.URL.Path {
		case "/twirp/livekit.RoomService/GetParticipant":
			if !aware.Load() {
				http.NotFound(w, r)
				return
			}
			respond(w, http.StatusOK, map[string]string{"identity": target.Identity, "state": "ACTIVE"})
		case "/twirp/livekit.RoomService/RemoveParticipant":
			if failRemove.Swap(false) {
				http.Error(w, "temporarily unavailable", http.StatusServiceUnavailable)
				return
			}
			removed.Add(1)
		default:
			http.NotFound(w, r)
		}
	}))
	defer media.Close()
	cfg.PresenceURL = media.URL
	plan := func(moderator memberSession, to string) error {
		return server.planProtectedVoiceMove(ctx, cfg, moderator.Token, profile, source, to)
	}
	if err := plan(owner, destination); !errors.Is(err, access.ErrVoiceSlotLost) {
		t.Fatalf("a token reservation alone counted as a media participant: %v", err)
	}
	aware.Store(true)
	if err := plan(reader, destination); !errors.Is(err, access.HierarchyDenied) {
		t.Fatalf("moderator could move their own session: %v", err)
	}
	if err := plan(moderator, destination); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("source-only moderation could move: %v", err)
	}
	if err := plan(owner, closed); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("owner moved someone without destination access: %v", err)
	}
	if _, err := server.joinProtectedVoice(ctx, owner.Token, full, cfg); err != nil {
		t.Fatal(err)
	}
	choices := func(token, channel, session string, want []string) {
		t.Helper()
		got, err := server.protectedVoiceMoveChoices(ctx, token, channel, session)
		if err != nil || !slices.Equal(got, want) {
			t.Fatalf("move choices: got %v, want %v: %v", got, want, err)
		}
	}
	choices(owner.Token, source, original.Identity, []string{destination})
	choices(owner.Token, closed, original.Identity, nil)
	choices(owner.Token, source, strings.Repeat("e", 32), nil)
	choices(owner.Token, full, owner.Access.SessionID, []string{destination, closed})
	choices(reader.Token, full, owner.Access.SessionID, nil)
	choices(reader.Token, source, original.Identity, []string{destination})
	choices(moderator.Token, source, original.Identity, nil)
	choices(moderator.Token, full, owner.Access.SessionID, nil)
	if err := plan(owner, full); !errors.Is(err, access.ErrVoiceFull) {
		t.Fatalf("owner moved someone into a full room: %v", err)
	}
	if _, _, err := server.leaveProtectedVoice(ctx, owner.Token); err != nil {
		t.Fatal(err)
	}
	if err := plan(owner, destination); err != nil {
		t.Fatal(err)
	}
	choices(owner.Token, source, original.Identity, nil)
	updateACL := func(id string, acl *access.ACL) {
		commit(access.PolicyDraft{Action: access.UpdateChannelACL, OperationID: strings.Repeat(id, 32),
			ResourceChange: &access.PolicyResourceChange{ID: destination, ACL: acl}})
	}
	updateACL("2", &closedACL)
	if err := server.applyProtectedVoiceMove(ctx, cfg, profile); err != nil || removed.Load() != 0 {
		t.Fatalf("a revoked destination still removed the source: %v", err)
	}
	updateACL("3", &destinationACL)
	if err := server.planProtectedVoiceMoveTarget(ctx, cfg, owner.Token, "", strings.Repeat("e", 32), source, destination); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("unknown source session could be targeted: %v", err)
	}
	if err := server.planProtectedVoiceMoveTarget(ctx, cfg, owner.Token, "", original.Identity, source, destination); err != nil {
		t.Fatal(err)
	}
	if _, err := server.joinProtectedVoice(ctx, owner.Token, destination, cfg); !errors.Is(err, access.ErrVoiceFull) {
		t.Fatalf("pending move failed to reserve capacity: %v", err)
	}
	failRemove.Store(true)
	if err := server.applyProtectedVoiceMove(ctx, cfg, profile); err == nil {
		t.Fatal("failed source removal was acknowledged")
	}
	if ready, err := server.readyProtectedVoiceMove(ctx, reader.Token); err != nil || ready != "" {
		t.Fatalf("destination exposed before source removal: %q, %v", ready, err)
	}
	if err := server.applyProtectedVoiceMove(ctx, cfg, profile); err != nil || removed.Load() != 1 {
		t.Fatalf("move was not retried exactly once: %v", err)
	}
	if ready, err := server.readyProtectedVoiceMove(ctx, reader.Token); err != nil || ready != destination {
		t.Fatalf("target cannot retrieve destination: %q, %v", ready, err)
	}
	secondSession := loginTestMember(t, server, newTestMemberSigner(2))
	if ready, err := server.readyProtectedVoiceMove(ctx, secondSession.Token); err != nil || ready != "" {
		t.Fatalf("move disclosed to another session: %q, %v", ready, err)
	}
	grant, err := server.joinProtectedVoice(ctx, reader.Token, destination, cfg)
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.Split(grant.Token, ".")
	raw, err := b64.DecodeString(encoded[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		Video struct {
			Publish *bool `json:"canPublish"`
		}
	}
	if err := json.Unmarshal(raw, &claims); err != nil || claims.Video.Publish == nil || *claims.Video.Publish {
		t.Fatalf("moving granted Speak: %v", err)
	}
	if ready, err := server.readyProtectedVoiceMove(ctx, reader.Token); err != nil || ready != "" {
		t.Fatalf("move remained after destination join: %q, %v", ready, err)
	}
	expectedRoom.Store(grant.Room)
	if err := server.disconnectProtectedVoice(ctx, cfg, moderator.Token, destination, grant.Identity); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("disconnect ignored the destination ACL: %v", err)
	}
	if err := server.disconnectProtectedVoice(ctx, cfg, owner.Token, destination, grant.Identity); err != nil || removed.Load() != 2 {
		t.Fatalf("owner did not disconnect the active voice participant: %v", err)
	}
	if _, err := server.joinProtectedVoice(ctx, reader.Token, destination, cfg); err != nil {
		t.Fatalf("disconnect prevented rejoining: %v", err)
	}
}
