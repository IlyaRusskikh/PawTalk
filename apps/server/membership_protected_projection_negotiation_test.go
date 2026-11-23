package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedProjectionNegotiationPreservesV16(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	store, _, owner, _ := protectedTestState(t, server)
	legacy, previous, current := access.TextRoleViewDenyProjectionVersion, access.TextNewcomerAdmissionProjectionVersion, access.ProfileRoleAuthorityProjectionVersion
	anchor, _, open, call := openScopedACLFixture(t, ctx, server, store, owner, legacy)
	token := open(owner, 1)
	input, err := json.Marshal(access.PolicyDraft{Action: access.CreatePolicyCategory, OperationID: strings.Repeat("2", 32),
		ResourceChange: &access.PolicyResourceChange{ID: strings.Repeat("3", 32), Name: "Synthetic category"}})
	if err != nil {
		t.Fatal(err)
	}
	const path = "/api/v3/policy/preview?"
	for _, test := range []struct {
		query   string
		version int
		status  int
	}{
		{query: "projection=16", version: legacy, status: http.StatusOK},
		{query: "projection=16&maxProjection=16", version: legacy, status: http.StatusOK},
		{query: "projection=16&maxProjection=17", version: previous, status: http.StatusOK},
		{query: "projection=17&maxProjection=18", version: current, status: http.StatusOK},
		{query: "projection=17&maxProjection=16", status: http.StatusBadRequest},
		{query: "projection=18", version: current, status: http.StatusOK},
		{query: "projection=18&maxProjection=19", version: current, status: http.StatusOK},
		{query: "projection=19", status: http.StatusBadRequest},
	} {
		t.Run(test.query, func(t *testing.T) {
			body := call(http.MethodPost, path+test.query, token, input, test.status)
			if test.status != http.StatusOK {
				return
			}
			var preview access.PolicyPreview
			if err := json.Unmarshal(body, &preview); err != nil {
				t.Fatal(err)
			}
			draft := preview.Draft
			if draft.TextProjectionVersion != test.version || !validHexID(draft.TextProjectionRoot, 64) ||
				draft.PreviousDigest != anchor.Digest || draft.Revision != anchor.Draft.Revision+1 {
				t.Fatalf("wrong projection or policy basis: v%d, revision %d", draft.TextProjectionVersion, draft.Revision)
			}
		})
	}
	head, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil || head.Digest != anchor.Digest || head.Draft.TextProjectionVersion != legacy {
		t.Fatalf("projection preview changed the signed v16 head: v%d, %v", head.Draft.TextProjectionVersion, err)
	}
}
