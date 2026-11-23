package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedCommunityNameTLS(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	var ordinary memberSession
	store, initial, owner, editor := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{"server.edit"}}
		identity := newTestMemberSigner(3)
		activateTestMember(t, server, identity, "member")
		ordinary = loginTestMember(t, server, identity)
		profile, device := ordinary.Access.EffectiveProfileID, ordinary.Access.DeviceID
		state.Members[profile] = access.Subject{ID: profile, Active: true}
		state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 43)}
	})
	_, _, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
	ownerToken, editorToken, ordinaryToken := open(owner, 1), open(editor, 2), open(ordinary, 3)
	read := func(token string) (access.CommunityName, bool) {
		t.Helper()
		var state struct {
			Community        access.CommunityName `json:"community"`
			CanEditCommunity bool
		}
		if err := json.Unmarshal(call(http.MethodGet, "/api/v3/state", token, nil, http.StatusOK), &state); err != nil {
			t.Fatal(err)
		}
		return state.Community, state.CanEditCommunity
	}
	before, canEdit := read(editorToken)
	viewerName, viewerCanEdit := read(ordinaryToken)
	if !canEdit || viewerCanEdit || before.Name == "" || before.Revision < 1 || before != viewerName {
		t.Fatalf("unexpected community projection: %+v (%v) vs %+v (%v)", before, canEdit, viewerName, viewerCanEdit)
	}
	encode := func(value any) []byte {
		t.Helper()
		body, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	rename := func(token, name string, revision int64, status int) {
		t.Helper()
		raw := call(http.MethodPut, "/api/v3/community/name", token, encode(access.CommunityName{Name: name, Revision: revision}), status)
		if status == http.StatusOK {
			var result access.CommunityName
			if err := json.Unmarshal(raw, &result); err != nil || result != (access.CommunityName{Name: name, Revision: revision + 1}) {
				t.Fatalf("unexpected rename result: %s (%v)", raw, err)
			}
		}
	}
	rename(ordinaryToken, "Forbidden name", before.Revision, http.StatusForbidden)
	rename(editorToken, "\n", before.Revision, http.StatusBadRequest)
	rename(editorToken, "Renamed community", before.Revision, http.StatusOK)
	rename(editorToken, "Renamed community", before.Revision, http.StatusOK)
	rename(ownerToken, "Stale owner edit", before.Revision, http.StatusConflict)
	after, canEdit := read(ordinaryToken)
	if canEdit || after != (access.CommunityName{Name: "Renamed community", Revision: before.Revision + 1}) {
		t.Fatalf("unexpected name after a concurrent edit: %+v (%v)", after, canEdit)
	}
	initial.Roles["reader"] = access.Role{}
	intent := access.PolicyDraft{
		Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("f", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order},
	}
	var preview access.PolicyPreview
	if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", ownerToken, encode(intent), http.StatusOK), &preview); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, "/api/v3/policy/commit", ownerToken,
		encode(signTestPolicyDraft(t, server, owner, 1, preview.Draft)), http.StatusOK)
	rename(editorToken, "Former privilege", after.Revision, http.StatusForbidden)
	if current, canEdit := read(editorToken); canEdit || current != after {
		t.Fatalf("revoked privilege stayed visible or changed the name: %+v (%v)", current, canEdit)
	}
	audit := call(http.MethodGet, "/api/v3/audit", ownerToken, nil, http.StatusOK)
	if strings.Count(string(audit), `"action":"server.rename"`) != 1 ||
		!strings.Contains(string(audit), editor.Access.EffectiveProfileID) || strings.Contains(string(audit), "Renamed community") {
		t.Fatalf("unexpected rename audit evidence: %s", audit)
	}
}
