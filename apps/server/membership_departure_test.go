package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMembershipDepartureDetails(t *testing.T) {
	for _, kind := range []string{"kick", "temporary", "permanent"} {
		t.Run(kind, func(t *testing.T) {
			s := testMembershipStore(t)
			ctx := context.Background()
			admin := bootstrapTestServer(t, s, newTestMemberSigner(1))
			signer := newTestMemberSigner(2)
			who := activateTestMember(t, s, signer, "member")
			var expires *int64
			if kind == "temporary" {
				value := s.now().Add(time.Hour).UnixMilli()
				expires = &value
			}
			var err error
			if kind == "kick" {
				err = s.kick(ctx, admin.Token, who.ProfileID, strings.Repeat("3", 32))
			} else {
				err = s.ban(ctx, admin.Token, who.ProfileID, strings.Repeat("3", 32), expires, "")
			}
			if err != nil {
				t.Fatal(err)
			}
			proof := signer.proof(t, s, "POST", "/api/v2/session", []byte(`{}`))
			_, err = s.session(ctx, proof, "POST", "/api/v2/session", []byte(`{}`))
			var denial *membershipError
			if !errors.As(err, &denial) {
				t.Fatalf("missing authenticated denial: %v", err)
			}
			if kind == "kick" {
				if denial.Code != "NOT_A_MEMBER" || denial.Details["membershipState"] != "kicked" {
					t.Fatalf("wrong kick: %+v", denial)
				}
			} else {
				if denial.Code != "BANNED" {
					t.Fatalf("ban reported as kick: %+v", denial)
				}
				if expires == nil {
					if denial.Details["expiresAt"] != nil {
						t.Fatal("permanent ban gained expiry")
					}
				} else if denial.Details["expiresAt"] != *expires {
					t.Fatal("wrong expiry")
				}
			}
			response := httptest.NewRecorder()
			memberFail(response, err)
			var body struct {
				Error struct {
					Details map[string]any `json:"details"`
				} `json:"error"`
			}
			if json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Error.Details == nil {
				t.Fatal("HTTP omitted departure details")
			}
		})
	}
}
