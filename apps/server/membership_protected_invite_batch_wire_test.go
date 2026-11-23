package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedInviteBatchResponseLimit(t *testing.T) {
	response := httptest.NewRecorder()
	sent := false
	batch := access.RotationTask{InviteAdmissions: &access.InviteAdmissionBatchEvidence{
		Admissions: []access.InviteAdmissionBatchItem{
			{Draft: &access.ScopedInviteReceipt{Admission: access.InvitePolicyAdmission{
				Claim: access.InviteRedeem{Nickname: strings.Repeat("a", 16<<20)},
			}}},
		},
	}}
	err := writeProtectedDelivery(response, &sent, batch)
	if err == nil || sent || response.Body.Len() != 0 {
		t.Fatalf("oversized witness was partially written: sent=%v size=%d err=%v", sent, response.Body.Len(), err)
	}
	protectedRuntimeFail(response, err)
	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), "PROTECTED_PROOF_RESPONSE_TOO_LARGE") {
		t.Fatalf("oversized witness returned the wrong failure: %d %s", response.Code, response.Body.String())
	}
}
