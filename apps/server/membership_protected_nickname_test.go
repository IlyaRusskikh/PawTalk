package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedNicknamesTLS(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	channelID := strings.Repeat("c", 32)
	var peer, hidden memberSession
	store, _, owner, delegate := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles[access.Everyone] = access.Role{Grants: []string{access.ChannelView}}
		state.Roles["reader"] = access.Role{Grants: []string{access.EditOwnNickname, "profile.edit-other"}}
		state.Roles["hidden"] = access.Role{}
		state.Order = []string{"reader", "hidden"}
		enroll := func(seed byte, role string) memberSession {
			t.Helper()
			identity := newTestMemberSigner(seed)
			activateTestMember(t, server, identity, "member")
			session := loginTestMember(t, server, identity)
			profile, device := session.Access.EffectiveProfileID, session.Access.DeviceID
			state.Members[profile] = access.Subject{ID: profile, Active: true, Roles: []string{role}}
			state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(seed)}
			state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, seed+40)}
			return session
		}
		peer, hidden = enroll(3, "reader"), enroll(4, "hidden")
		state.Channels = map[string]access.Channel{channelID: {Kind: "text", NextPosition: 1, ACL: access.ACL{
			Roles: map[string]access.Overwrite{"hidden": {Deny: []string{access.ChannelView}}},
		}}}
	})
	_, _, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
	ownerToken, delegateToken, peerToken, hiddenToken := open(owner, 1), open(delegate, 2), open(peer, 3), open(hidden, 4)
	ownerID, delegateID, peerID, hiddenID := owner.Access.EffectiveProfileID, delegate.Access.EffectiveProfileID,
		peer.Access.EffectiveProfileID, hidden.Access.EffectiveProfileID
	route := func(profile string) string { return "/api/v3/profiles/" + profile + "/nickname" }
	update := func(token, profile, scope, name string, revision int64, status int) []byte {
		t.Helper()
		body, err := json.Marshal(access.NicknameUpdate{ChannelID: scope, Name: name, Revision: revision})
		if err != nil {
			t.Fatal(err)
		}
		return call(http.MethodPut, route(profile), token, body, status)
	}
	expectName := func(raw []byte, name string, revision int64) {
		t.Helper()
		var result access.NicknameState
		if err := json.Unmarshal(raw, &result); err != nil || result != (access.NicknameState{Name: name, Revision: revision}) {
			t.Fatalf("unexpected nickname state: %s (%v)", raw, err)
		}
	}
	readRoster := func(token, route string) access.RosterPage {
		t.Helper()
		var page access.RosterPage
		if err := json.Unmarshal(call(http.MethodGet, route, token, nil, http.StatusOK), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	channelRoster := "/api/v3/roster/text/" + channelID
	originalDigest := readRoster(delegateToken, channelRoster).NicknameDigest
	update(hiddenToken, hiddenID, "", "Denied self edit", 0, http.StatusForbidden)
	update(delegateToken, ownerID, channelID, "Denied higher rank", 0, http.StatusForbidden)
	update(delegateToken, hiddenID, channelID, "Denied hidden target", 0, http.StatusForbidden)
	call(http.MethodGet, route(peerID), delegateToken, nil, http.StatusForbidden)
	expectName(update(delegateToken, delegateID, "", "Own nickname", 0, http.StatusOK), "Own nickname", 1)
	expectName(update(delegateToken, peerID, channelID, "Equal rank nickname", 0, http.StatusOK), "Equal rank nickname", 1)
	expectName(update(delegateToken, peerID, channelID, "Equal rank nickname", 0, http.StatusOK), "Equal rank nickname", 1)
	update(peerToken, peerID, "", "Stale overwrite", 0, http.StatusConflict)
	expectName(call(http.MethodGet, route(peerID), peerToken, nil, http.StatusOK), "Equal rank nickname", 1)

	page := readRoster(delegateToken, channelRoster)
	if page.NicknameDigest == "" || page.NicknameDigest == originalDigest {
		t.Fatal("renaming a visible member did not change the roster version")
	}
	foundPeer := false
	for _, member := range page.Members {
		switch member.ID {
		case ownerID:
			if member.CanEditNickname {
				t.Fatal("owner advertised as editable at lower rank")
			}
		case peerID:
			foundPeer = true
			if !member.CanEditNickname || member.Name != "Equal rank nickname" {
				t.Fatalf("peer nickname not projected: %+v", member)
			}
		case hiddenID:
			t.Fatal("hidden member present in roster")
		}
	}
	if !foundPeer {
		t.Fatal("peer missing from permitted roster")
	}
	globalRoster := "/api/v3/roster/members"
	globalBefore := readRoster(ownerToken, globalRoster).NicknameDigest
	expectName(update(ownerToken, hiddenID, "", "Nickname outside the channel", 0, http.StatusOK), "Nickname outside the channel", 1)
	if readRoster(ownerToken, globalRoster).NicknameDigest == globalBefore ||
		readRoster(delegateToken, channelRoster).NicknameDigest != page.NicknameDigest {
		t.Fatal("nickname change outside the channel affected the wrong roster version")
	}
	audit := call(http.MethodGet, "/api/v3/audit", ownerToken, nil, http.StatusOK)
	if strings.Count(string(audit), `"action":"profile.edit-other"`) != 2 ||
		strings.Contains(string(audit), "Equal rank nickname") || strings.Contains(string(audit), "Nickname outside the channel") {
		t.Fatalf("unexpected nickname audit evidence: %s", audit)
	}
}
