package main

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedVoiceRestrictionSessionAuthority(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	channel := strings.Repeat("c", 32)
	otherChannel := strings.Repeat("d", 32)
	var administrator memberSession
	policy, _, owner, listener := protectedTestStateWith(t, server, func(state *access.State) {
		signer := newTestMemberSigner(3)
		activateTestMember(t, server, signer, "member")
		administrator = loginTestMember(t, server, signer)
		profile := administrator.Access.EffectiveProfileID
		state.Roles["administrator"] = access.Role{Grants: []string{access.Administrator}}
		state.Order = append(state.Order, "administrator")
		state.Members[profile] = access.Subject{ID: profile, Active: true, Roles: []string{"administrator"}}
		state.PolicyDevices[administrator.Access.DeviceID] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.RecoveryReady = map[string]bool{profile: true}
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, "voice.connect", "voice.speak"}}
		state.Channels[channel] = access.Channel{Kind: "voice", NextPosition: 1,
			Settings: &access.ChannelSettings{Name: "Voice capacity", VoiceCapacity: 1}}
		state.Channels[otherChannel] = access.Channel{Kind: "voice", NextPosition: 1}
	})
	anchor, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, anchor)); err != nil {
		t.Fatal(err)
	}
	cfg := config{APIKey: "synthetic", APISecret: strings.Repeat("k", 64)}
	checkReceive := func(session string, allowed bool) {
		t.Helper()
		var receives bool
		if err := server.db.QueryRowContext(ctx, "SELECT can_receive FROM protected_voice_slots WHERE session_id=? AND channel_id=?", session, otherChannel).Scan(&receives); err != nil || receives != allowed {
			t.Fatalf("voice grant can_receive=%v, want %v: %v", receives, allowed, err)
		}
	}
	grant, err := server.joinProtectedVoice(ctx, listener.Token, channel, cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, privileged := range []memberSession{owner, administrator} {
		if _, err := server.joinProtectedVoice(ctx, privileged.Token, channel, cfg); !errors.Is(err, access.ErrVoiceFull) {
			t.Fatalf("privileged profile bypassed the occupied slot: %v", err)
		}
	}
	check := func(token, session, profile string, actions []access.VoiceRestrictionChoice) {
		t.Helper()
		result, err := server.protectedVoiceRestrictionChoices(ctx, token, channel, session)
		if err != nil || result.ProfileID != profile || !slices.Equal(result.Actions, actions) {
			t.Fatalf("restriction choices %+v, want %q %v, error %v", result, profile, actions, err)
		}
	}
	profile := listener.Access.EffectiveProfileID
	global := []access.VoiceRestrictionChoice{{Action: access.ChangeVoiceMute, ServerWide: true}, {Action: access.ChangeVoiceDeafen, ServerWide: true}}
	initial := append([]access.VoiceRestrictionChoice{{Action: access.ChangeVoiceMute}, {Action: access.ChangeVoiceDeafen}}, global...)
	check(owner.Token, grant.Identity, profile, initial)
	check(administrator.Token, grant.Identity, profile, initial)
	check(listener.Token, grant.Identity, "", nil)
	check(owner.Token, strings.Repeat("e", 32), "", nil)
	prepare := func(session memberSession, action, operation, source string, mode access.MoveAccess, lift bool) access.PolicyDraft {
		t.Helper()
		preview, err := policy.PreviewPolicyForTransport(ctx, server.protectedSession(session.Token), access.PolicyDraft{
			Action: action, OperationID: strings.Repeat(operation, 32), ResourceChange: &access.PolicyResourceChange{
				ID: source, Mode: mode, TargetProfileID: profile, VoiceTargetSessionID: grant.Identity, Lift: lift,
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(preview.Snapshot) == 0 {
			t.Fatal("administrator did not receive a verifiable management snapshot")
		}
		return preview.Draft
	}
	mute := prepare(administrator, access.ChangeVoiceMute, "2", channel, "", false)
	if _, err := server.commitProtectedPolicy(ctx, administrator.Token, signTestPolicyDraft(t, server, administrator, 3, mute)); err != nil {
		t.Fatal(err)
	}
	check(administrator.Token, grant.Identity, profile, append([]access.VoiceRestrictionChoice{
		{Action: access.ChangeVoiceMute, Lift: true}, {Action: access.ChangeVoiceDeafen},
	}, global...))
	serverDeafen := prepare(administrator, access.ChangeVoiceDeafen, "5", channel, "server", false)
	if _, err := server.commitProtectedPolicy(ctx, administrator.Token, signTestPolicyDraft(t, server, administrator, 3, serverDeafen)); err != nil {
		t.Fatal(err)
	}
	stale := prepare(owner, access.ChangeVoiceDeafen, "3", channel, "", false)
	if _, _, err := server.leaveProtectedVoice(ctx, listener.Token); err != nil {
		t.Fatal(err)
	}
	check(owner.Token, grant.Identity, "", nil)
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, stale)); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("stale exact-session moderation was applied: %v", err)
	}
	grant, err = server.joinProtectedVoice(ctx, listener.Token, otherChannel, cfg)
	if err != nil {
		t.Fatal(err)
	}
	checkReceive(grant.Identity, false)
	lift := prepare(administrator, access.ChangeVoiceDeafen, "6", otherChannel, "server", true)
	if _, err := server.commitProtectedPolicy(ctx, administrator.Token, signTestPolicyDraft(t, server, administrator, 3, lift)); err != nil {
		t.Fatal(err)
	}
	grant, err = server.joinProtectedVoice(ctx, listener.Token, otherChannel, cfg)
	if err != nil {
		t.Fatal(err)
	}
	checkReceive(grant.Identity, true)
	capacity, err := server.previewProtectedPolicy(ctx, owner.Token, access.PolicyDraft{
		Action: access.EditPolicyChannel, OperationID: strings.Repeat("4", 32),
		ResourceChange: &access.PolicyResourceChange{ID: channel,
			Settings: &access.ChannelSettings{Name: "Voice capacity", VoiceCapacity: 3}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, capacity)); err != nil {
		t.Fatal(err)
	}
	for _, privileged := range []memberSession{owner, administrator} {
		if _, err := server.joinProtectedVoice(ctx, privileged.Token, channel, cfg); err != nil {
			t.Fatalf("available slot after changing channel capacity was rejected: %v", err)
		}
	}
	destinations, err := server.protectedVoiceMoveChoices(ctx, administrator.Token, channel, owner.Access.SessionID)
	if err != nil || !slices.Contains(destinations, otherChannel) {
		t.Fatalf("administrator cannot move the owner: %v, %v", destinations, err)
	}
	changeServerRestriction := func(session, target memberSession, signer byte, operation, action string, lift bool) {
		t.Helper()
		draft, err := server.previewProtectedPolicy(ctx, session.Token, access.PolicyDraft{
			Action: action, OperationID: strings.Repeat(operation, 32),
			ResourceChange: &access.PolicyResourceChange{ID: channel, Mode: "server",
				TargetProfileID: target.Access.EffectiveProfileID, VoiceTargetSessionID: target.Access.SessionID, Lift: lift},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := server.commitProtectedPolicy(ctx, session.Token, signTestPolicyDraft(t, server, session, signer, draft)); err != nil {
			t.Fatal(err)
		}
	}
	changeServerRestriction(administrator, owner, 3, "7", access.ChangeVoiceMute, false)
	check(owner.Token, owner.Access.SessionID, owner.Access.EffectiveProfileID,
		[]access.VoiceRestrictionChoice{{Action: access.ChangeVoiceMute, ServerWide: true, Lift: true}})
	changeServerRestriction(owner, owner, 1, "8", access.ChangeVoiceMute, true)
	check(owner.Token, owner.Access.SessionID, "", nil)
	changeServerRestriction(owner, administrator, 1, "9", access.ChangeVoiceMute, false)
	changeServerRestriction(owner, administrator, 1, "a", access.ChangeVoiceDeafen, false)
	check(administrator.Token, administrator.Access.SessionID, administrator.Access.EffectiveProfileID,
		[]access.VoiceRestrictionChoice{
			{Action: access.ChangeVoiceMute, ServerWide: true, Lift: true},
			{Action: access.ChangeVoiceDeafen, ServerWide: true, Lift: true},
		})
	changeServerRestriction(administrator, administrator, 3, "b", access.ChangeVoiceMute, true)
	changeServerRestriction(administrator, administrator, 3, "c", access.ChangeVoiceDeafen, true)
	check(administrator.Token, administrator.Access.SessionID, "", nil)
}
