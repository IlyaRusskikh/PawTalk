package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
)

const scopedInviteReceiptLimit = 16 << 10

func supportsScopedInviteReceipts(version int) bool {
	return version >= TextNewcomerAdmissionProjectionVersion && HasTextRecipientProjection(version)
}

// ScopedInviteReceipt proves an automatic admission without exporting its
// policy draft, private projection seed, or policy snapshot.
type ScopedInviteReceipt struct {
	Revision       int64                 `json:"revision"`
	PreviousDigest string                `json:"previousDigest"`
	ResultDigest   string                `json:"resultDigest"`
	ProjectionRoot string                `json:"projectionRoot"`
	Digest         string                `json:"digest"`
	OperationID    string                `json:"operationId"`
	Actor          Principal             `json:"actor"`
	Admission      InvitePolicyAdmission `json:"admission"`
	Signature      []byte                `json:"signature"`
}

type SignScopedInviteReceipt func(context.Context, SessionQuery, ScopedInviteReceipt) ([]byte, error)

// ScopedInviteReceiptFrame signs the public admission and the exact previous
// and successor policy. It deliberately never accepts a PolicyDraft.
func ScopedInviteReceiptFrame(serverID string, receipt ScopedInviteReceipt) ([]byte, error) {
	admission := receipt.Admission
	claim, issuer := admission.Claim, admission.Issuance
	if !validInviteHex(serverID, 32) || receipt.Revision < 2 || receipt.Revision > maxInviteUseLimit ||
		!isDigest(receipt.PreviousDigest) || !isDigest(receipt.ResultDigest) || !isDigest(receipt.ProjectionRoot) || !isDigest(receipt.Digest) ||
		!validInviteHex(receipt.OperationID, 32) || !isDigest(admission.CutoverDigest) ||
		!validInviteHex(claim.InviteID, 32) || !validInviteHex(claim.OperationID, 32) || !validRecipientKey(claim.AgreementKey) ||
		issuer == nil || issuer.PolicyRevision < 1 || issuer.PolicyRevision >= receipt.Revision || !isDigest(issuer.PolicyDigest) ||
		!isDigest(issuer.Issuer.ProfileID) || !isDigest(issuer.Issuer.DeviceID) ||
		issuer.CreatedAt < 0 || issuer.AcceptedAt < issuer.CreatedAt || issuer.ExpiresAt <= issuer.AcceptedAt ||
		issuer.ExpiresAt > maxInviteDate || issuer.RequestedExpiry < 0 || issuer.RequestedExpiry > maxInviteDate ||
		issuer.MaxUses < 0 || issuer.MaxUses > maxInviteUseLimit {
		return nil, ErrPolicyConflict
	}
	public, valid := inviteClaimKey(admission.ServerKey)
	if !valid || hexHash(public)[:32] != serverID {
		return nil, ErrPolicyConflict
	}
	profile, profileValid := inviteClaimKey(claim.ProfilePublicKey)
	device, deviceValid := inviteClaimKey(claim.DevicePublicKey)
	if !profileValid || !deviceValid || hexHash(profile) != receipt.Actor.ProfileID || hexHash(device) != receipt.Actor.DeviceID {
		return nil, ErrPolicyConflict
	}
	return SignatureFrame("pawtalk-protected-invite-scoped-receipt-v1", serverID,
		strconv.FormatInt(receipt.Revision, 10), receipt.PreviousDigest, receipt.ResultDigest, receipt.ProjectionRoot, receipt.Digest,
		receipt.OperationID, receipt.Actor.ProfileID, receipt.Actor.DeviceID, admission.CutoverDigest, admission.ServerKey,
		claim.InviteID, claim.OperationID, claim.InvitePublicKey, claim.ProfilePublicKey, claim.DevicePublicKey, claim.AgreementKey,
		claim.Nickname, claim.InviteSignature, claim.ProfileSignature, claim.DeviceSignature,
		issuer.Issuer.ProfileID, issuer.Issuer.DeviceID, strconv.FormatInt(issuer.PolicyRevision, 10), issuer.PolicyDigest,
		strconv.FormatInt(issuer.RequestedExpiry, 10), strconv.FormatInt(issuer.CreatedAt, 10), strconv.FormatInt(issuer.ExpiresAt, 10),
		strconv.FormatInt(issuer.AcceptedAt, 10), strconv.FormatInt(issuer.MaxUses, 10), issuer.Signature)
}

func verifyStoredScopedInviteReceipt(ctx context.Context, query SessionQuery, receipt ScopedInviteReceipt) error {
	var serverID string
	var key []byte
	if err := query.QueryRowContext(ctx, "SELECT server_id,identity_public_key FROM server_state WHERE id=1").Scan(&serverID, &key); err != nil {
		return err
	}
	frame, err := ScopedInviteReceiptFrame(serverID, receipt)
	if err != nil || len(key) != ed25519.PublicKeySize || receipt.Admission.ServerKey != base64.RawURLEncoding.EncodeToString(key) ||
		!ed25519.Verify(ed25519.PublicKey(key), frame, receipt.Signature) {
		return ErrPolicyConflict
	}
	return nil
}

func storeScopedInviteReceipt(ctx context.Context, tx *sql.Tx, proof PolicyProof, sign SignScopedInviteReceipt) error {
	draft := proof.Draft
	if sign == nil || draft.Action != RedeemPolicyInvite || !supportsScopedInviteReceipts(draft.TextProjectionVersion) ||
		draft.ResourceChange == nil || draft.ResourceChange.Admission == nil {
		return ErrPolicyConflict
	}
	receipt := ScopedInviteReceipt{Revision: draft.Revision, PreviousDigest: draft.PreviousDigest,
		ResultDigest: draft.ResultDigest, ProjectionRoot: draft.TextProjectionRoot, Digest: proof.Digest, OperationID: draft.OperationID,
		Actor: proof.Principal, Admission: *draft.ResourceChange.Admission}
	var err error
	receipt.Signature, err = sign(ctx, tx, receipt)
	if err != nil {
		return err
	}
	if err := verifyStoredScopedInviteReceipt(ctx, tx, receipt); err != nil {
		return err
	}
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if len(raw) > scopedInviteReceiptLimit {
		return ErrPolicyConflict
	}
	// Existing v16 databases have no receipt table until their first v17 admission.
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_scoped_invite_receipts (
		successor_digest TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE REFERENCES protected_policy_proofs(revision),
		record BLOB NOT NULL
	) STRICT`); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_scoped_invite_receipts(successor_digest,revision,record) VALUES(?,?,?)`,
		receipt.Digest, receipt.Revision, raw)
	return err
}

// ReadScopedInviteReceipt returns only the signed public receipt. Callers must
// authorize its disclosure in their current transaction. Legacy admissions and
// revisions without a compact receipt return nil.
func ReadScopedInviteReceipt(ctx context.Context, query SessionQuery, successorHead string) (*ScopedInviteReceipt, error) {
	if !isDigest(successorHead) {
		return nil, InvalidAction
	}
	var exists bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='protected_scoped_invite_receipts')`).Scan(&exists); err != nil || !exists {
		return nil, err
	}
	var raw []byte
	var revision int64
	var digest sql.NullString
	err := query.QueryRowContext(ctx, `SELECT r.record,r.revision,p.digest FROM protected_scoped_invite_receipts r
		LEFT JOIN protected_policy_proofs p ON p.revision=r.revision WHERE r.successor_digest=?`, successorHead).Scan(&raw, &revision, &digest)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var receipt ScopedInviteReceipt
	if len(raw) > scopedInviteReceiptLimit || !digest.Valid || digest.String != successorHead ||
		json.Unmarshal(raw, &receipt) != nil || receipt.Digest != successorHead || receipt.Revision != revision {
		return nil, ErrPolicyConflict
	}
	canonical, err := json.Marshal(receipt)
	if err != nil || !bytes.Equal(canonical, raw) {
		return nil, ErrPolicyConflict
	}
	if err := verifyStoredScopedInviteReceipt(ctx, query, receipt); err != nil {
		return nil, err
	}
	return &receipt, nil
}
