package access

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestInviteAdmissionBatchMarkerBindsOrderedReceipts(t *testing.T) {
	base, first, second, policy := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("d", 64)
	evidence := InviteAdmissionBatchEvidence{
		PreviousRevision: 5, PreviousHead: base, SuccessorHead: second,
		Admissions: []InviteAdmissionBatchItem{
			{Draft: &ScopedInviteReceipt{Revision: 6, PreviousDigest: base, Digest: first, Signature: bytes.Repeat([]byte{1}, 64)}},
			{Draft: &ScopedInviteReceipt{Revision: 7, PreviousDigest: first, Digest: second, ResultDigest: policy, Signature: bytes.Repeat([]byte{2}, 64)}},
		},
	}
	record := EpochRecord{ChannelID: strings.Repeat("9", 32), Revision: 7, PolicyDigest: policy}
	for purpose, expected := range map[string]string{
		LiveEpoch:    "ac68232ad3b2ae6f5573d002e96d0e0af8b3be935507bd8145f1e6d44ace59bc",
		ArchiveEpoch: "99ce1b8e3e7faaffd1211d30d9eaa059b0cbe26b1e88093914a153c736dea536",
	} {
		record.Purpose = purpose
		if got, err := inviteAdmissionBatchDigest(record, evidence); err != nil || got != expected {
			t.Fatalf("%s marker %s, %v", purpose, got, err)
		}
	}
	evidence.Admissions[0], evidence.Admissions[1] = evidence.Admissions[1], evidence.Admissions[0]
	if _, err := inviteAdmissionBatchDigest(record, evidence); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("reordered batch got a marker: %v", err)
	}
}
