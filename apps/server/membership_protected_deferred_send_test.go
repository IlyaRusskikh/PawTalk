package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedDeferredSendRequiresContinuousAdmission(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		t.Run(fmt.Sprintf("interrupted=%t", interrupted), func(t *testing.T) {
			const channel = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			ctx := t.Context()
			server := testMembershipStore(t)
			store, state, owner, reader := protectedTestStateWith(t, server, func(state *access.State) {
				state.Channels = map[string]access.Channel{channel: {Kind: "text", NextPosition: 1}}
			})
			anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
			owner.Token, reader.Token = open(owner, 1), open(reader, 2)
			profile := reader.Access.EffectiveProfileID
			encode := func(value any) []byte {
				t.Helper()
				body, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				return body
			}
			apply := func(op string, assignments map[string][]string) access.PolicyProof {
				t.Helper()
				var preview access.PolicyPreview
				intent := access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat(op, 32),
					RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order, Assignments: assignments}}
				if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", owner.Token, encode(intent), http.StatusOK), &preview); err != nil {
					t.Fatal(err)
				}
				var proof access.PolicyProof
				if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/commit", owner.Token,
					encode(signTestPolicyDraft(t, server, owner, 1, preview.Draft)), http.StatusOK), &proof); err != nil {
					t.Fatal(err)
				}
				return proof
			}
			role := state.Roles["reader"]
			role.Grants = append(role.Grants, "channel.edit")
			state.Roles["reader"] = role
			current := apply("2", nil)
			if interrupted {
				apply("3", map[string][]string{profile: nil})
				current = apply("4", map[string][]string{profile: {"reader"}})
			}
			snapshot, _, err := store.Snapshot(ctx)
			if err != nil || snapshot.Admissions[channel][profile].FirstPosition != 1 {
				t.Fatalf("expected the same first position after the policy change: %+v (%v)", snapshot.Admissions[channel][profile], err)
			}
			key := strings.Repeat("a", 64)
			epoch, packages := prepareTestEpoch(t, server, owner, 1, channel, key)
			if err := server.commitProtectedEpoch(ctx, owner.Token, epoch, packages); err != nil {
				t.Fatal(err)
			}
			attempt := signProtectedTestMessage(t, server, reader, 2, access.MessageAttempt{ChannelID: channel,
				KeyID: key, OperationID: strings.Repeat("5", 32), Nonce: make([]byte, 12), Ciphertext: make([]byte, 17)})
			room := httptest.NewTLSServer(runtime.handler())
			defer room.Close()
			send := func(proof access.PolicyProof, status int) access.MessageReceipt {
				t.Helper()
				request, err := http.NewRequestWithContext(ctx, http.MethodPost, room.URL+"/api/v3/history/live/"+channel, bytes.NewReader(encode(attempt)))
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Authorization", "Bearer "+reader.Token)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("X-PawTalk-Deferred-Policy", fmt.Sprintf("%d:%s", proof.Draft.Revision, proof.Digest))
				response, err := room.Client().Do(request)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatal(err)
				}
				if response.StatusCode != status {
					t.Fatalf("send returned %d, want %d: %s", response.StatusCode, status, body)
				}
				var receipt access.MessageReceipt
				if status == http.StatusConflict {
					if !bytes.Contains(body, []byte(`"code":"PROTECTED_DEFERRED_ADMISSION_CHANGED"`)) {
						t.Fatalf("unexpected conflict: %s", body)
					}
				} else if err := json.Unmarshal(body, &receipt); err != nil {
					t.Fatal(err)
				}
				return receipt
			}
			basis := anchor
			if interrupted {
				send(anchor, http.StatusConflict)
				basis = current
			}
			wrongHead := basis
			wrongHead.Digest = strings.Repeat("7", 64)
			send(wrongHead, http.StatusConflict)
			if receipt := send(basis, http.StatusOK); receipt.Position != 1 || receipt.Existing {
				t.Fatalf("unexpected first receipt: %+v", receipt)
			}
			if receipt := send(basis, http.StatusOK); receipt.Position != 1 || !receipt.Existing {
				t.Fatalf("unexpected retry receipt: %+v", receipt)
			}
		})
	}
}
