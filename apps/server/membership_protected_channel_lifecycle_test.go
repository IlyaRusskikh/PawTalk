package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedMixedRootChannelOrder(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	text, voice, categorized, category := strings.Repeat("a", 32), strings.Repeat("b", 32), strings.Repeat("c", 32), strings.Repeat("d", 32)
	store, _, owner, _ := protectedTestStateWith(t, server, func(state *access.State) {
		state.Categories = map[string]access.ACL{category: {}}
		state.Channels = map[string]access.Channel{
			text: {Kind: "text", NextPosition: 1}, voice: {Kind: "voice", NextPosition: 1},
			categorized: {Kind: "text", CategoryID: category, NextPosition: 1},
		}
		state.ChannelOrder = []string{text, categorized, voice}
	})
	anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
	token := open(owner, 1)
	encode := func(value any) []byte {
		t.Helper()
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	intent := access.PolicyDraft{Action: access.OrderPolicyChannel, OperationID: strings.Repeat("2", 32),
		ResourceChange: &access.PolicyResourceChange{ID: text, AnchorID: voice, After: true}}
	call(http.MethodPost, "/api/v3/policy/preview", token, encode(intent), http.StatusForbidden)
	intent.ResourceChange.MixedOrder = true
	var preview access.PolicyPreview
	if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", token, encode(intent), http.StatusOK), &preview); err != nil {
		t.Fatal(err)
	}
	if preview.ChannelOrderBasisVersion != 3 {
		t.Fatalf("mixed root preview has basis version %d", preview.ChannelOrderBasisVersion)
	}
	change := access.ChannelLayoutChange{OperationID: intent.OperationID, Source: text, Anchor: voice, After: true,
		Revision: anchor.Draft.Revision, PolicyHead: anchor.Digest, OrderBasis: preview.ChannelOrderBasis, BasisVersion: 3}
	actor := access.Principal{ProfileID: owner.Access.EffectiveProfileID, DeviceID: owner.Access.DeviceID}
	frame, err := access.ChannelLayoutFrame(runtime.serverID, actor, change)
	if err != nil {
		t.Fatal(err)
	}
	change.Signature = ed25519.Sign(newTestMemberSigner(1).device, frame)
	var receipt access.ChannelLayoutReceipt
	if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/channel-order", token, encode(change), http.StatusOK), &receipt); err != nil {
		t.Fatal(err)
	}
	var projection access.Projection
	if err := json.Unmarshal(call(http.MethodGet, "/api/v3/state", token, nil, http.StatusOK), &projection); err != nil {
		t.Fatal(err)
	}
	var actual []string
	for _, channel := range projection.Channels {
		actual = append(actual, channel.ID)
	}
	if !slices.Equal(actual, []string{voice, categorized, text}) {
		t.Fatalf("mixed order moved a categorized slot: %v", actual)
	}
	body := call(http.MethodGet, "/api/v3/policy/channel-order/"+text+"/proof?digest="+receipt.Digest, token, nil, http.StatusOK)
	var evidence access.ChannelLayoutEvidence
	if err := json.Unmarshal(body, &evidence); err != nil || evidence.Change.BasisVersion != 3 || evidence.Digest != receipt.Digest {
		t.Fatalf("mixed order evidence could not be loaded: %s, %v", body, err)
	}
}

func TestProtectedChannelLifecycleAndDirectoryTLS(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	category, outside := strings.Repeat("c", 32), strings.Repeat("d", 32)
	var text, voice string
	var directory, offline memberSession
	store, initial, owner, delegate := protectedTestStateWith(t, server, func(state *access.State) {
		if err := server.db.QueryRow(`SELECT
			(SELECT channel_id FROM channels WHERE protected_kind='default_text'),
			(SELECT channel_id FROM channels WHERE protected_kind='default_voice')`).Scan(&text, &voice); err != nil {
			t.Fatal(err)
		}
		enroll := func(seed byte, role string) memberSession {
			t.Helper()
			identity := newTestMemberSigner(seed)
			activateTestMember(t, server, identity, "member")
			login := loginTestMember(t, server, identity)
			profile, device := login.Access.EffectiveProfileID, login.Access.DeviceID
			state.Members[profile] = access.Subject{ID: profile, Active: true, Roles: []string{role}}
			state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(seed)}
			state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, seed+40)}
			return login
		}
		state.Roles[access.Everyone] = access.Role{Grants: []string{access.ChannelView}}
		state.Roles["reader"] = access.Role{Grants: []string{"channel.delete"}}
		state.Roles["directory"] = access.Role{Grants: []string{"member.list"}}
		state.Roles["offline"] = access.Role{}
		state.Order = []string{"reader", "directory", "offline"}
		directory, offline = enroll(3, "directory"), enroll(4, "offline")
		state.Categories = map[string]access.ACL{category: {}}
		state.CategoryNames = map[string]string{category: "Synthetic mixed category"}
		state.Channels = map[string]access.Channel{
			text: {Kind: "text", CategoryID: category, NextPosition: 1, Settings: &access.ChannelSettings{Name: "Default text"},
				ACL: access.ACL{Roles: map[string]access.Overwrite{"directory": {Deny: []string{access.ChannelView}}}}},
			voice: {Kind: "voice", CategoryID: category, NextPosition: 1, Settings: &access.ChannelSettings{Name: "Default voice"},
				ACL: access.ACL{Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView, "channel.delete"}}}}},
			outside: {Kind: "text", NextPosition: 1, Settings: &access.ChannelSettings{Name: "Outside category"}},
		}
	})
	anchor, _, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
	ownerToken, delegateToken, directoryToken := open(owner, 1), open(delegate, 2), open(directory, 3)
	// The offline member is enrolled and has no protected runtime session.
	encode := func(input any) []byte {
		t.Helper()
		result, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	state := func(token string) access.Projection {
		t.Helper()
		var result access.Projection
		if err := json.Unmarshal(call(http.MethodGet, "/api/v3/state", token, nil, http.StatusOK), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	roster := func(token, route string) []string {
		t.Helper()
		var page access.RosterPage
		if err := json.Unmarshal(call(http.MethodGet, "/api/v3/roster/"+route, token, nil, http.StatusOK), &page); err != nil {
			t.Fatal(err)
		}
		keys := make([]string, 0, len(page.Members))
		for _, member := range page.Members {
			keys = append(keys, member.ID)
		}
		slices.Sort(keys)
		return keys
	}
	all := []string{owner.Access.EffectiveProfileID, delegate.Access.EffectiveProfileID, directory.Access.EffectiveProfileID, offline.Access.EffectiveProfileID}
	slices.Sort(all)
	closed := slices.DeleteFunc(slices.Clone(all), func(profile string) bool { return profile == directory.Access.EffectiveProfileID })
	if !slices.Equal(roster(delegateToken, "text/"+text), closed) || !slices.Equal(roster(directoryToken, "text/"+outside), all) ||
		!slices.Equal(roster(directoryToken, "members"), all) || !state(directoryToken).CanListMembers {
		t.Fatal("channel and server rosters did not respect their separate scopes")
	}
	call(http.MethodGet, "/api/v3/roster/members", delegateToken, nil, http.StatusForbidden)
	call(http.MethodGet, "/api/v3/roster/text/"+text, directoryToken, nil, http.StatusForbidden)
	call(http.MethodGet, "/api/v3/policy/proofs?after=0", directoryToken, nil, http.StatusForbidden)
	unchangedRoles := access.PolicyDraft{
		Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("7", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order},
	}
	call(http.MethodPost, "/api/v3/policy/preview", directoryToken, encode(unchangedRoles), http.StatusForbidden)

	before := state(ownerToken)
	if len(before.Categories) != 1 || before.Categories[0].ID != category || len(before.Channels) != 3 {
		t.Fatalf("mixed category or uncategorized channel missing: %+v", before)
	}
	for _, channel := range before.Channels {
		want := category
		if channel.ID == outside {
			want = ""
		}
		if channel.CategoryID != want {
			t.Fatalf("parent for %s = %q, want %q", channel.ID, channel.CategoryID, want)
		}
	}
	call(http.MethodPost, "/api/v3/policy/preview", ownerToken, encode(access.PolicyDraft{
		Action: access.CreatePolicyCategory, OperationID: strings.Repeat("8", 32),
		ResourceChange: &access.PolicyResourceChange{ID: strings.Repeat("b", 32), CategoryID: category, Name: "Synthetic nested category"},
	}), http.StatusBadRequest)
	removeCategory := access.PolicyDraft{Action: access.DeletePolicyCategory, OperationID: strings.Repeat("9", 32),
		ResourceChange: &access.PolicyResourceChange{ID: category, Mode: access.DeleteChildren}}
	preview := func(intent access.PolicyDraft) access.PolicyDraft {
		t.Helper()
		var output access.PolicyPreview
		if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", ownerToken, encode(intent), http.StatusOK), &output); err != nil {
			t.Fatal(err)
		}
		return output.Draft
	}
	call(http.MethodPost, "/api/v3/policy/commit", directoryToken,
		encode(signTestPolicyDraft(t, server, directory, 3, preview(unchangedRoles))), http.StatusForbidden)
	call(http.MethodPost, "/api/v3/policy/preview", delegateToken, encode(removeCategory), http.StatusForbidden)
	authorized := preview(removeCategory)
	call(http.MethodPost, "/api/v3/policy/commit", delegateToken,
		encode(signTestPolicyDraft(t, server, delegate, 2, authorized)), http.StatusForbidden)
	if after := state(ownerToken); !reflect.DeepEqual(before, after) || after.PolicyRevision != anchor.Draft.Revision {
		t.Fatalf("failed category deletion changed policy or removed a child: %+v", after)
	}

	for index, channel := range []string{outside, text, voice} {
		intent := access.PolicyDraft{Action: access.DeletePolicyChannel, OperationID: strings.Repeat(string(rune('a'+index)), 32),
			ResourceChange: &access.PolicyResourceChange{ID: channel}}
		draft := preview(intent)
		if len(state(ownerToken).Channels) != 3-index {
			t.Fatal("preview removed a channel")
		}
		call(http.MethodPost, "/api/v3/policy/commit", ownerToken, encode(signTestPolicyDraft(t, server, owner, 1, draft)), http.StatusOK)
		if remaining := len(state(ownerToken).Channels); remaining != 2-index {
			t.Fatalf("after deleting %s, have %d channels", channel, remaining)
		}
	}
}
