package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedRequestRateLimits(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	var timeMillis atomic.Int64
	timeMillis.Store(server.now().UnixMilli())
	server.now = func() time.Time { return time.UnixMilli(timeMillis.Load()) }
	var member memberSession
	store, initial, owner, administrator := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView, access.Administrator}}
		signer := newTestMemberSigner(3)
		activateTestMember(t, server, signer, "member")
		member = loginTestMember(t, server, signer)
		profile, device := member.Access.EffectiveProfileID, member.Access.DeviceID
		state.Members[profile] = access.Subject{ID: profile, Active: true}
		state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(3)}
		state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, 43)}
	})
	_, _, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
	ownerToken, adminToken, memberToken := open(owner, 1), open(administrator, 2), open(member, 3)
	for range 120 {
		call(http.MethodGet, "/api/config", "", nil, http.StatusOK)
	}
	call(http.MethodGet, "/api/config", ownerToken, nil, http.StatusTooManyRequests)
	for range 121 {
		call(http.MethodGet, "/api/v3/state", memberToken, nil, http.StatusOK)
	}
	call(http.MethodGet, "/api/v3/state", adminToken, nil, http.StatusOK)
	call(http.MethodGet, "/api/v3/state", ownerToken, nil, http.StatusOK)
	call(http.MethodGet, "/api/v3/state", strings.Repeat("A", 43), nil, http.StatusTooManyRequests)

	limiter := newProtectedRequestLimiter(server)
	handler := limiter.limited(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	expect := func(token string, status int, retryAfter string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/v3/state", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, r)
		if recorder.Code != status || recorder.Header().Get("Retry-After") != retryAfter {
			t.Fatalf("got status %d and Retry-After %q, want %d and %q", recorder.Code, recorder.Header().Get("Retry-After"), status, retryAfter)
		}
	}
	for range protectedMemberRequestsPerMinute {
		expect(memberToken, http.StatusNoContent, "")
	}
	timeMillis.Add((56 * time.Second).Milliseconds())
	expect(memberToken, http.StatusTooManyRequests, "4")
	expect(open(member, 3), http.StatusTooManyRequests, "4")

	// An exhausted profile budget still has no effect while it has the
	// Administrator grant. Removing that grant takes effect in the same session.
	limiter.members.attempts[administrator.Access.EffectiveProfileID] = attempt{count: protectedMemberRequestsPerMinute, start: server.now()}
	limiter.members.attempts[owner.Access.EffectiveProfileID] = attempt{count: protectedMemberRequestsPerMinute, start: server.now()}
	expect(adminToken, http.StatusNoContent, "")
	expect(ownerToken, http.StatusNoContent, "")
	initial.Roles["reader"] = access.Role{Grants: []string{access.ChannelView}}
	intent := access.PolicyDraft{
		Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("f", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order},
	}
	encoded, err := json.Marshal(intent)
	if err != nil {
		t.Fatal(err)
	}
	var preview access.PolicyPreview
	if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", ownerToken, encoded, http.StatusOK), &preview); err != nil {
		t.Fatal(err)
	}
	signed, err := json.Marshal(signTestPolicyDraft(t, server, owner, 1, preview.Draft))
	if err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, "/api/v3/policy/commit", ownerToken, signed, http.StatusOK)
	expect(adminToken, http.StatusTooManyRequests, "60")
	timeMillis.Add((4 * time.Second).Milliseconds())
	expect(memberToken, http.StatusNoContent, "")
}
