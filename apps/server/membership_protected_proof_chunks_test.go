package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedProofChunkTransport(t *testing.T) {
	value := access.RotationTask{InviteAdmissions: &access.InviteAdmissionBatchEvidence{
		Admissions: []access.InviteAdmissionBatchItem{{Draft: &access.ScopedInviteReceipt{Admission: access.InvitePolicyAdmission{
			Claim: access.InviteRedeem{Nickname: strings.Repeat("a", protectedProofChunkBytes)},
		}}}},
	}}
	lease := strings.Repeat("1", 32)
	all, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(all)
	wantTag := `"` + hex.EncodeToString(sum[:]) + `"`
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proof, err := readProtectedProofRequest(r, r.URL.Query().Get("scoped") == "1", true)
		var sent bool
		if err == nil {
			err = proof.write(w, &sent, value, lease)
		}
		if err != nil && !sent {
			protectedRuntimeFail(w, err)
		}
	}))
	defer server.Close()
	request := func(offset, tag, resumedLease string, status int, scoped bool) (*http.Response, []byte) {
		t.Helper()
		endpoint := server.URL + "/claim"
		if scoped {
			endpoint += "?scoped=1"
		}
		req, err := http.NewRequest(http.MethodPost, endpoint, nil)
		if err != nil {
			t.Fatal(err)
		}
		for header, field := range map[string]string{protectedProofOffset: offset, "If-Match": tag, protectedProofLease: resumedLease} {
			if field != "" {
				req.Header.Set(header, field)
			}
		}
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != status {
			t.Fatalf("proof response yielded %d, size %d, %v", response.StatusCode, len(body), err)
		}
		return response, body
	}
	first, start := request("0", "", "", http.StatusPartialContent, true)
	next, end := request(strconv.Itoa(protectedProofChunkBytes), wantTag, lease, http.StatusPartialContent, true)
	for _, response := range []*http.Response{first, next} {
		if response.Header.Get("ETag") != wantTag || response.Header.Get("Content-Type") != "application/octet-stream" ||
			response.Header.Get("Cache-Control") != "private, no-store" || response.Header.Get(protectedProofLease) != lease {
			t.Fatalf("incorrect protected chunk headers: %v", response.Header)
		}
	}
	if len(start) != protectedProofChunkBytes || first.Header.Get("Content-Range") != fmt.Sprintf("bytes 0-%d/%d", len(start)-1, len(all)) ||
		next.Header.Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", len(start), len(all)-1, len(all)) ||
		!bytes.Equal(start, all[:len(start)]) || !bytes.Equal(end, all[len(start):]) {
		t.Fatal("proof chunks did not reproduce exact canonical JSON")
	}
	if _, body := request(strconv.Itoa(protectedProofChunkBytes), `"`+strings.Repeat("2", 64)+`"`, lease, http.StatusPreconditionFailed, true); !bytes.Contains(body, []byte("PROTECTED_PROOF_CHANGED")) {
		t.Fatal("mismatched ETag returned no explicit stale error")
	}
	for _, offset := range []string{"00", "1", "+0", "18446744073709551615"} {
		request(offset, "", "", http.StatusBadRequest, true)
	}
	request("0", "", "", http.StatusBadRequest, false)
	request(strconv.Itoa(protectedProofChunkBytes), "W/"+wantTag, lease, http.StatusBadRequest, true)
	request(strconv.Itoa(protectedProofChunkBytes), wantTag, "", http.StatusBadRequest, true)
	request(strconv.Itoa(protectedProofChunkBytes), wantTag, strings.Repeat("3", 32), http.StatusPreconditionFailed, true)
	request(strconv.Itoa(2*protectedProofChunkBytes), wantTag, lease, http.StatusRequestedRangeNotSatisfiable, true)
	request("", "", "", http.StatusRequestEntityTooLarge, true)
}

type protectedProofDeadlineRecorder struct{ *httptest.ResponseRecorder }

func (*protectedProofDeadlineRecorder) SetWriteDeadline(time.Time) error { return nil }

func TestProtectedProofClaimContinuationDoesNotRenewLease(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	now := time.Unix(1_800_000_000, 0)
	server.now = func() time.Time { return now }
	channel := strings.Repeat("a", 32)
	store, _, owner, _ := protectedTestStateWith(t, server, func(state *access.State) {
		delete(state.Channels, "private")
		state.Channels[channel] = access.Channel{Kind: "text", NextPosition: 1}
	})
	_, runtime, open, _ := openScopedACLFixture(t, ctx, server, store, owner, access.TextNewcomerAdmissionProjectionVersion)
	token := open(owner, 1)
	call := func(offset, match, lease, session string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/api/v3/keys/rotate/"+channel+"/live/claim?scoped=1", nil)
		r.SetPathValue("channel", channel)
		r.SetPathValue("purpose", access.LiveEpoch)
		r.Header.Set("Authorization", "Bearer "+session)
		r.Header.Set(protectedProofOffset, offset)
		if match != "" {
			r.Header.Set("If-Match", match)
			r.Header.Set(protectedProofLease, lease)
		}
		response := httptest.NewRecorder()
		runtime.claimRotationHTTP(&protectedProofDeadlineRecorder{response}, r)
		return response
	}
	first := call("0", "", "", token)
	var task access.RotationTask
	if first.Code != http.StatusOK || first.Header().Get(protectedProofLease) != "" ||
		first.Header().Get("ETag") != "" || first.Header().Get("Content-Type") != "application/json" ||
		json.Unmarshal(first.Body.Bytes(), &task) != nil || task.LeaseID == "" {
		t.Fatalf("small negotiated proof changed the ordinary response: %d %s", first.Code, first.Body.String())
	}
	var oldLease string
	var oldUntil int64
	now = time.UnixMilli(task.LeaseUntil)
	tag := `"` + strings.Repeat("f", 64) + `"`
	response := call(strconv.Itoa(protectedProofChunkBytes), tag, task.LeaseID, token)
	if response.Code != http.StatusPreconditionFailed || !bytes.Contains(response.Body.Bytes(), []byte("PROTECTED_PROOF_CHANGED")) {
		t.Fatalf("expired proof did not fail stale: %d %s", response.Code, response.Body.String())
	}
	if err := server.db.QueryRow(`SELECT lease_id,lease_until FROM protected_rotation_tasks WHERE task_id=?`, task.TaskID).
		Scan(&oldLease, &oldUntil); err != nil || oldLease != task.LeaseID || oldUntil != task.LeaseUntil {
		t.Fatalf("proof continuation replaced or renewed expired lease: %q %d %v", oldLease, oldUntil, err)
	}
	unauthorized := call(strconv.Itoa(protectedProofChunkBytes), tag, task.LeaseID, "invalid-token")
	if unauthorized.Code != http.StatusUnauthorized || !bytes.Contains(unauthorized.Body.Bytes(), []byte("INVALID_PROTECTED_SESSION")) {
		t.Fatalf("proof continuation changed session authorization: %d %s", unauthorized.Code, unauthorized.Body.String())
	}
}
