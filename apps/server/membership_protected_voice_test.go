package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedVoiceAdmissionAndGrant(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(20000, 375000000)
	if os.Getenv("PAWTALK_TEST_PROTECTED_MEDIA") == "1" {
		now = time.Now().UTC().Truncate(time.Second).Add(375 * time.Millisecond)
	}
	server.now = func() time.Time { return now }
	channelID := strings.Repeat("a", 32)
	closedID := strings.Repeat("b", 32)
	var otherSession memberSession
	_, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect"}}
		state.Channels[channelID] = access.Channel{Kind: "voice", NextPosition: 1, Settings: &access.ChannelSettings{Name: "Voice", VoiceCapacity: 1}}
		state.Channels[closedID] = access.Channel{Kind: "voice", NextPosition: 1, ACL: access.ACL{
			Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}},
		}}
		profile := publicKeyID(newTestMemberSigner(2).root.Public().(ed25519.PublicKey))
		other := newTestMemberSigner(3)
		id := activateTestMember(t, server, other, "member")
		if _, err := server.db.Exec("INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)",
			id.ProfileID, profile, now.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if _, err := server.db.Exec("UPDATE memberships SET state='linked' WHERE profile_id=?", id.ProfileID); err != nil {
			t.Fatal(err)
		}
		otherSession = loginTestMember(t, server, other)
		state.PolicyDevices[id.DeviceID] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
	})
	commitDraft := func(ctx context.Context, draft access.PolicyDraft) error {
		preview, err := server.previewProtectedPolicy(ctx, owner.Token, draft)
		if err != nil {
			return err
		}
		_, err = server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, preview))
		return err
	}
	commit := func(action, operation string, update *access.RolePolicyUpdate) {
		t.Helper()
		if err := commitDraft(ctx, access.PolicyDraft{
			Action: action, OperationID: operation, RoleUpdate: update,
		}); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("c", 64)}
	if _, err := server.joinProtectedVoice(ctx, owner.Token, channelID, cfg); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("unanchored room issued a grant: %v", err)
	}
	commit(access.AnchorPolicy, strings.Repeat("1", 32), nil)
	if _, err := server.joinProtectedVoice(ctx, reader.Token, closedID, cfg); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("closed voice issued a grant: %v", err)
	}
	grant, err := server.joinProtectedVoice(ctx, reader.Token, channelID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	checkClaims := func(grant memberVoice, speak bool) {
		t.Helper()
		parts := strings.Split(grant.Token, ".")
		if len(parts) != 3 {
			t.Fatal("grant is not a signed JWT")
		}
		raw, err := b64.DecodeString(parts[1])
		if err != nil {
			t.Fatal(err)
		}
		var claims struct {
			Subject string `json:"sub"`
			Expires int64  `json:"exp"`
			Video   struct {
				Join        bool     `json:"roomJoin"`
				Room        string   `json:"room"`
				Publish     *bool    `json:"canPublish"`
				Subscribe   bool     `json:"canSubscribe"`
				PublishData *bool    `json:"canPublishData"`
				Sources     []string `json:"canPublishSources"`
			} `json:"video"`
			RoomConfig json.RawMessage `json:"roomConfig"`
		}
		if err := json.Unmarshal(raw, &claims); err != nil {
			t.Fatal(err)
		}
		if !grant.E2EERequired || !strings.HasPrefix(grant.Room, "ptp-") ||
			claims.Subject != grant.Identity || claims.Expires != now.Add(protectedVoiceLease).Unix() ||
			claims.Video.Room != grant.Room || !claims.Video.Join || !claims.Video.Subscribe ||
			claims.Video.Publish == nil || *claims.Video.Publish != speak || claims.Video.PublishData == nil || *claims.Video.PublishData ||
			len(claims.RoomConfig) != 0 {
			t.Fatalf("incorrect LiveKit claims: %+v", claims)
		}
		if speak && (len(claims.Video.Sources) != 1 || claims.Video.Sources[0] != "microphone") ||
			!speak && len(claims.Video.Sources) != 0 {
			t.Fatalf("incorrect publication sources: %v", claims.Video.Sources)
		}
	}
	checkClaims(grant, false)
	native := os.Getenv("PAWTALK_TEST_PROTECTED_MEDIA") == "1"
	if native {
		verifyProtectedVoiceMedia(t, server, cfg, grant, false, nil, nil)
	}
	if _, err := server.joinProtectedVoice(ctx, owner.Token, channelID, cfg); !errors.Is(err, access.ErrVoiceFull) {
		t.Fatalf("owner bypassed voice capacity: %v", err)
	}
	if _, err := server.joinProtectedVoice(ctx, otherSession.Token, channelID, cfg); !errors.Is(err, access.ErrVoiceOccupied) {
		t.Fatalf("second session obtained the same profile's slot: %v", err)
	}
	if err := server.heartbeatProtectedVoice(ctx, reader.Token); err != nil {
		t.Fatal(err)
	}
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect", "voice.speak"}}
	commit(access.UpdatePolicyRoles, strings.Repeat("2", 32), &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order})
	if err := server.heartbeatProtectedVoice(ctx, reader.Token); !errors.Is(err, access.ErrVoiceGrantChanged) {
		t.Fatalf("heartbeat accepted outdated grant: %v", err)
	}
	speaker, err := server.joinProtectedVoice(ctx, reader.Token, channelID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	checkClaims(speaker, true)
	profile := reader.Access.EffectiveProfileID
	moderation := []access.PolicyDraft{
		{Action: access.ChangeVoiceMute, OperationID: strings.Repeat("a", 32),
			ResourceChange: &access.PolicyResourceChange{ID: channelID, TargetProfileID: profile}},
		{Action: access.ChangeVoiceDeafen, OperationID: strings.Repeat("b", 32),
			ResourceChange: &access.PolicyResourceChange{ID: channelID, TargetProfileID: profile}},
		{Action: access.ChangeVoiceDeafen, OperationID: strings.Repeat("c", 32),
			ResourceChange: &access.PolicyResourceChange{ID: channelID, TargetProfileID: profile, Lift: true}},
	}
	steps := []voiceMediaStep{{Publish: false, Subscribe: true}, {Publish: false, Subscribe: false}, {Publish: false, Subscribe: true}}
	change := func(ctx context.Context, media config, index int) error {
		if err := commitDraft(ctx, moderation[index]); err != nil {
			return err
		}
		if err := server.reconcilePendingProtectedVoice(ctx, media); err != nil {
			return err
		}
		return server.heartbeatProtectedVoice(ctx, reader.Token)
	}
	if native {
		verifyProtectedVoiceMedia(t, server, cfg, speaker, true, append(steps, voiceMediaStep{Disconnect: true}),
			func(ctx context.Context, media config, index int) error {
				if index < len(steps) {
					return change(ctx, media, index)
				}
				withoutConnect := map[string]access.Role{
					access.Everyone: state.Roles[access.Everyone],
					"reader":        {Grants: []string{access.ChannelView}},
				}
				if err := commitDraft(ctx, access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("5", 32),
					RoleUpdate: &access.RolePolicyUpdate{Roles: withoutConnect, Order: state.Order}}); err != nil {
					return err
				}
				if _, err := server.joinProtectedVoice(ctx, reader.Token, channelID, media); !errors.Is(err, access.MissingGrant) {
					return fmt.Errorf("voice grant after Connect revocation: expected missing grant, got %v", err)
				}
				return server.reconcilePendingProtectedVoice(ctx, media)
			})
		commit(access.UpdatePolicyRoles, strings.Repeat("6", 32), &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order})
		// The old grant still reserves the slot for its session until expiry.
		// Test immediate re-entry with that session, then the linked device below.
		if _, err := server.joinProtectedVoice(ctx, otherSession.Token, channelID, cfg); !errors.Is(err, access.ErrVoiceOccupied) {
			t.Fatalf("linked session obtained the slot before the original grant expired: %v", err)
		}
		muted, err := server.joinProtectedVoice(ctx, reader.Token, channelID, cfg)
		if err != nil {
			t.Fatalf("fresh grant for the original voice session after confirmed removal: %v", err)
		}
		if muted.Identity != speaker.Identity || muted.Token == speaker.Token {
			t.Fatal("reconnect must keep its session identity and issue a new token")
		}
		checkClaims(muted, false)
		verifyProtectedVoiceMedia(t, server, cfg, muted, false, []voiceMediaStep{{Disconnect: true}},
			func(ctx context.Context, media config, _ int) error {
				if _, _, err := server.leaveProtectedVoice(ctx, reader.Token); err != nil {
					return err
				}
				return server.reconcilePendingProtectedVoice(ctx, media)
			})
	} else {
		type controlRequest struct {
			Room       string
			Identity   string
			Permission voiceMediaStep
		}
		requests := make(chan controlRequest, len(steps))
		var unavailable atomic.Bool
		unavailable.Store(true)
		media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				Room       string
				Identity   string
				Permission struct{ CanPublish, CanSubscribe bool }
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || r.URL.Path != "/twirp/livekit.RoomService/UpdateParticipant" {
				http.Error(w, fmt.Sprint(err), http.StatusBadRequest)
				return
			}
			if unavailable.Swap(false) {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			requests <- controlRequest{body.Room, body.Identity, voiceMediaStep{Publish: body.Permission.CanPublish, Subscribe: body.Permission.CanSubscribe}}
			w.WriteHeader(http.StatusOK)
		}))
		defer media.Close()
		cfg.PresenceURL = media.URL
		for i, expected := range steps {
			err := change(ctx, cfg, i)
			if i == 0 {
				if err == nil || !strings.Contains(err.Error(), "HTTP 503") {
					t.Fatalf("unavailable LiveKit was acknowledged: %v", err)
				}
				if err := server.heartbeatProtectedVoice(ctx, reader.Token); !errors.Is(err, access.ErrVoiceGrantChanged) {
					t.Fatalf("failed media update altered the recorded grant: %v", err)
				}
				err = server.reconcilePendingProtectedVoice(ctx, cfg)
			}
			if err != nil {
				t.Fatal(err)
			}
			select {
			case received := <-requests:
				if received != (controlRequest{grant.Room, grant.Identity, expected}) {
					t.Fatalf("wrong LiveKit update at step %d: %+v", i, received)
				}
			default:
				t.Fatalf("LiveKit update missing at step %d", i)
			}
		}
	}
	if _, _, err := server.leaveProtectedVoice(ctx, reader.Token); err != nil {
		t.Fatal(err)
	}
	absent := httptest.NewServer(http.NotFoundHandler())
	defer absent.Close()
	disconnected := cfg
	disconnected.PresenceURL = absent.URL
	if err := server.reconcilePendingProtectedVoice(ctx, disconnected); err != nil {
		t.Fatal(err)
	}
	now = now.Add(protectedVoiceLease)
	reader = otherSession
	grant, err = server.joinProtectedVoice(ctx, reader.Token, channelID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	checkClaims(grant, false)
	if native {
		if grant.Identity == speaker.Identity || reader.Access.EffectiveProfileID != profile {
			t.Fatal("linked-device reconnect must use a separate media identity on the same profile")
		}
		verifyProtectedVoiceMedia(t, server, cfg, grant, false, nil, nil)
	}
	selfLift := access.PolicyDraft{Action: access.ChangeVoiceMute, OperationID: strings.Repeat("d", 32),
		ResourceChange: &access.PolicyResourceChange{ID: channelID, TargetProfileID: profile, Lift: true}}
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, selfLift); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("self-lift succeeded without the current moderation grant: %v", err)
	}
	state.Roles["reader"] = access.Role{Grants: append(state.Roles["reader"].Grants, "voice.mute")}
	commit(access.UpdatePolicyRoles, strings.Repeat("e", 32), &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order})
	if _, err := server.previewProtectedPolicy(ctx, reader.Token, access.PolicyDraft{Action: access.ChangeVoiceMute, OperationID: strings.Repeat("f", 32),
		ResourceChange: &access.PolicyResourceChange{ID: channelID, TargetProfileID: owner.Access.EffectiveProfileID}}); !errors.Is(err, access.HierarchyDenied) {
		t.Fatalf("lower-ranked moderator muted the owner: %v", err)
	}
	lift, err := server.previewProtectedPolicy(ctx, reader.Token, selfLift)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.commitProtectedPolicy(ctx, reader.Token, signTestPolicyDraft(t, server, reader, 3, lift)); err != nil {
		t.Fatalf("holder of current mute permission could not lift their own restriction: %v", err)
	}
	state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView}}
	commit(access.UpdatePolicyRoles, strings.Repeat("3", 32), &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order})
	if err := server.heartbeatProtectedVoice(ctx, reader.Token); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("revoked voice authorization renewed: %v", err)
	}
	if _, err := server.joinProtectedVoice(ctx, reader.Token, channelID, cfg); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("revoked participant received a fresh token: %v", err)
	}
	if room, identity, err := server.leaveProtectedVoice(ctx, reader.Token); err != nil || room != grant.Room || identity != grant.Identity {
		t.Fatalf("leave after revoke: %q %q %v", room, identity, err)
	}
	grantExpiry := now.Add(protectedVoiceLease).Truncate(time.Second)
	now = grantExpiry.Add(-time.Millisecond)
	if _, err := server.joinProtectedVoice(ctx, owner.Token, channelID, cfg); !errors.Is(err, access.ErrVoiceFull) {
		t.Fatalf("capacity ignored unexpired token: %v", err)
	}
	now = grantExpiry
	if _, err := server.joinProtectedVoice(ctx, owner.Token, channelID, cfg); !errors.Is(err, access.ErrVoiceFull) {
		t.Fatalf("unacknowledged disconnect stopped holding capacity: %v", err)
	}
	if err := server.reconcilePendingProtectedVoice(ctx, disconnected); err != nil {
		t.Fatal(err)
	}
	if _, err := server.joinProtectedVoice(ctx, owner.Token, channelID, cfg); err != nil {
		t.Fatalf("expired token kept slot: %v", err)
	}
}
