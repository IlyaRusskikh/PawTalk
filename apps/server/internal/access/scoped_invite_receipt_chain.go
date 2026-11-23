package access

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"
)

const maxInviteAdmissionBatch = 8192 // The addressed epoch package limit.

// ReadScopedInviteReceiptChain returns an exact suffix of automatic
// admissions after an independently authenticated base. A different policy
// operation or a missing receipt makes the suffix unavailable.
func ReadScopedInviteReceiptChain(ctx context.Context, query SessionQuery, base, successor PolicyProof) ([]ScopedInviteReceipt, error) {
	count := successor.Draft.Revision - base.Draft.Revision
	version := base.Draft.TextProjectionVersion
	if base.Draft.Revision < 1 || count < 2 || count > maxInviteAdmissionBatch ||
		!supportsScopedInviteReceipts(version) || successor.Draft.TextProjectionVersion != version {
		return nil, nil
	}
	chain := make([]ScopedInviteReceipt, 0, count)
	previous := base.Digest
	for offset := int64(1); offset <= count; offset++ {
		revision := base.Draft.Revision + offset
		proof, err := readAttestedProof(ctx, query, revision)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		draft := proof.Draft
		if draft.Action != RedeemPolicyInvite || draft.TextProjectionVersion != version ||
			draft.PreviousDigest != previous || draft.ResourceChange == nil || draft.ResourceChange.Admission == nil ||
			draft.ResourceChange.Admission.Issuance == nil {
			return nil, nil
		}
		if revision == successor.Draft.Revision &&
			(proof.Digest != successor.Digest || draft.ResultDigest != successor.Draft.ResultDigest) {
			return nil, ErrPolicyConflict
		}
		receipt, err := ReadScopedInviteReceipt(ctx, query, proof.Digest)
		if err != nil || receipt == nil {
			return nil, err
		}
		admission := draft.ResourceChange.Admission
		if receipt.Revision != revision || receipt.PreviousDigest != previous || receipt.ResultDigest != draft.ResultDigest ||
			receipt.ProjectionRoot != draft.TextProjectionRoot || receipt.OperationID != draft.OperationID || receipt.Actor != proof.Principal ||
			receipt.Admission.CutoverDigest != admission.CutoverDigest || receipt.Admission.ServerKey != admission.ServerKey ||
			receipt.Admission.Claim != admission.Claim || receipt.Admission.Issuance == nil || *receipt.Admission.Issuance != *admission.Issuance {
			return nil, ErrPolicyConflict
		}
		chain = append(chain, *receipt)
		previous = receipt.Digest
	}
	return chain, nil
}

func inviteAdmissionBatchDigest(record EpochRecord, evidence InviteAdmissionBatchEvidence) (string, error) {
	if record.Purpose != LiveEpoch && record.Purpose != ArchiveEpoch {
		return "", InvalidAction
	}
	count := len(evidence.Admissions)
	if count < 2 || count > maxInviteAdmissionBatch || record.Revision-evidence.PreviousRevision != int64(count) {
		return "", InvalidAction
	}
	signatures := sha256.New()
	previous := evidence.PreviousHead
	for i, item := range evidence.Admissions {
		receipt := item.Draft
		if receipt == nil || len(receipt.Signature) != ed25519.SignatureSize || receipt.PreviousDigest != previous ||
			receipt.Revision != evidence.PreviousRevision+int64(i)+1 || !isDigest(receipt.Digest) ||
			i == count-1 && (receipt.Digest != evidence.SuccessorHead || receipt.ResultDigest != record.PolicyDigest) {
			return "", ErrPolicyConflict
		}
		signatures.Write(receipt.Signature)
		previous = receipt.Digest
	}
	frame, err := SignatureFrame("pawtalk-protected-"+record.Purpose+"-invite-admissions-v1", record.ChannelID,
		strconv.FormatInt(evidence.PreviousRevision, 10), evidence.PreviousHead, strconv.FormatInt(record.Revision, 10),
		evidence.SuccessorHead, record.PolicyDigest, strconv.Itoa(count), hex.EncodeToString(signatures.Sum(nil)))
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}
