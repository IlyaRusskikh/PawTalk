package access

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
)

var ErrInviteUnavailable = errors.New("protected invitation unavailable")

type InviteRedeem struct {
	InviteID         string `json:"inviteId"`
	OperationID      string `json:"operationId"`
	InvitePublicKey  string `json:"invitePublicKey"`
	ProfilePublicKey string `json:"profilePublicKey"`
	DevicePublicKey  string `json:"devicePublicKey"`
	AgreementKey     string `json:"agreementKey"`
	Nickname         string `json:"nickname"`
	InviteSignature  string `json:"inviteSignature"`
	ProfileSignature string `json:"profileSignature"`
	DeviceSignature  string `json:"deviceSignature"`
}

type InviteAdmission struct {
	InviteID    string `json:"inviteId"`
	ProfileID   string `json:"profileId"`
	DeviceID    string `json:"deviceId"`
	AcceptedAt  int64  `json:"acceptedAt"`
	Existing    bool   `json:"existing"`
	KeysPending bool   `json:"keysPending"`
}

type InviteApplicant struct {
	Principal
	TokenHash    string
	BoundProfile string
}

type PendingInviteAdmission struct {
	InviteAdmission
	Nickname        string         `json:"nickname"`
	DevicePublicKey string         `json:"-"`
	Claim           InviteRedeem   `json:"-"`
	Issuance        InviteIssuance `json:"-"`
}

// InviteIssuance carries the issuer's original authorization and the issuance
// policy address. Only the claimed capability's public key accompanies it.
type InviteIssuance struct {
	Issuer          Principal
	PolicyRevision  int64
	PolicyDigest    string
	RequestedExpiry int64
	CreatedAt       int64
	ExpiresAt       int64
	AcceptedAt      int64
	MaxUses         int64
	Signature       string
}

type VerifyInviteApplicant func(context.Context, SessionQuery, InviteRedeem) (InviteApplicant, error)

type InviteEnrollment struct {
	CutoverDigest string
	ServerKey     string
	Sign          func(context.Context, SessionQuery, Principal, PolicyDraft) ([]byte, error)
	SignReceipt   SignScopedInviteReceipt
}

func (s *Store) DispatchOwnerInviteAdmission(ctx context.Context, resolve ResolveSession, deliver func(SessionQuery) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if actor.ProfileID != state.Owner {
			return MissingGrant
		}
		return deliver(conn)
	})
}

// ReadPendingInviteAdmission authenticates the stored acceptance anew. A row
// is neither proof of the applicant's keys nor authority to open a channel.
func ReadPendingInviteAdmission(ctx context.Context, tx SessionQuery, deviceID string, now int64, authenticate VerifyInviteApplicant,
	verifyIssue VerifyInviteCreate, verifyPolicy VerifyPolicyDraft) (PendingInviteAdmission, error) {
	var result PendingInviteAdmission
	var issuer Principal
	var issue InviteCreate
	var operation, requestDigest string
	var raw []byte
	var createdAt, expiresAt, maxUses int64
	var revokedAt sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT a.profile_id,a.device_id,a.invite_id,a.operation_id,a.request_digest,a.request,a.accepted_at,
		i.creator_profile_id,i.creator_device_id,i.token_hash,i.requested_expiry,i.policy_digest,i.signature,i.created_at,i.expires_at,i.max_uses,i.revoked_at
		FROM protected_invite_admissions a JOIN protected_invites i ON i.id=a.invite_id WHERE a.device_id=?`, deviceID).
		Scan(&result.ProfileID, &result.DeviceID, &result.InviteID, &operation, &requestDigest, &raw, &result.AcceptedAt,
			&issuer.ProfileID, &issuer.DeviceID, &issue.TokenHash, &issue.ExpiresAt, &issue.PolicyDigest, &issue.Signature,
			&createdAt, &expiresAt, &maxUses, &revokedAt)
	if err != nil {
		return PendingInviteAdmission{}, err
	}
	issue.ID = result.InviteID
	expectedExpiry := issue.ExpiresAt
	if expectedExpiry == 0 {
		expectedExpiry = createdAt + millisecondsPerDay
	}
	if expiresAt != expectedExpiry || result.AcceptedAt < createdAt || result.AcceptedAt > now || result.AcceptedAt >= expiresAt ||
		revokedAt.Valid && revokedAt.Int64 < result.AcceptedAt {
		return PendingInviteAdmission{}, ErrInviteUnavailable
	}
	var claim InviteRedeem
	if json.Unmarshal(raw, &claim) != nil || hexHash(raw) != requestDigest || claim.InviteID != result.InviteID || claim.OperationID != operation ||
		!validRecipientKey(claim.AgreementKey) {
		return PendingInviteAdmission{}, ErrInviteConflict
	}
	applicant, err := authenticate(ctx, tx, claim)
	if err != nil {
		return PendingInviteAdmission{}, err
	}
	if applicant.DeviceID != result.DeviceID || applicant.ProfileID != result.ProfileID ||
		subtle.ConstantTimeCompare([]byte(issue.TokenHash), []byte(applicant.TokenHash)) != 1 {
		return PendingInviteAdmission{}, ErrInviteConflict
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return PendingInviteAdmission{}, err
	}
	if !state.PolicyAnchored || state.PolicyDevices[deviceID].Revoked || state.Members[applicant.BoundProfile].Active {
		return PendingInviteAdmission{}, ChannelRestricted
	}
	for _, profile := range []string{applicant.ProfileID, applicant.BoundProfile} {
		if removal := state.MemberRemovals[profile]; removal.BannedAt(now) {
			return PendingInviteAdmission{}, MemberBanError{removal}
		}
	}
	head, err := ReadPolicyHead(ctx, tx, nil)
	if err != nil {
		return PendingInviteAdmission{}, err
	}
	if err := verifyPolicy(ctx, tx, head.Principal, head.Draft); err != nil {
		return PendingInviteAdmission{}, err
	}
	revision, err := verifyInviteAuthority(ctx, tx, issuer, issue, maxUses, createdAt, verifyIssue, verifyPolicy)
	if err != nil {
		return PendingInviteAdmission{}, err
	}
	result.Nickname = claim.Nickname
	result.DevicePublicKey = claim.DevicePublicKey
	result.Claim = claim
	result.Issuance = InviteIssuance{Issuer: issuer, PolicyRevision: revision, PolicyDigest: issue.PolicyDigest,
		RequestedExpiry: issue.ExpiresAt, CreatedAt: createdAt, ExpiresAt: expiresAt, AcceptedAt: result.AcceptedAt,
		MaxUses: maxUses, Signature: base64.StdEncoding.EncodeToString(issue.Signature)}
	result.KeysPending = true
	return result, nil
}

func (s *Store) RedeemInvite(ctx context.Context, input InviteRedeem, authenticate VerifyInviteApplicant,
	verifyIssue VerifyInviteCreate, verifyPolicy VerifyPolicyDraft, enrollment *InviteEnrollment) (InviteAdmission, error) {
	if authenticate == nil || verifyIssue == nil || verifyPolicy == nil || !validInviteHex(input.InviteID, 32) ||
		!validInviteHex(input.OperationID, 32) || !validRecipientKey(input.AgreementKey) || enrollment != nil && enrollment.Sign == nil {
		return InviteAdmission{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return InviteAdmission{}, err
	}
	defer tx.Rollback()
	applicant, err := authenticate(ctx, tx, input)
	if err != nil {
		return InviteAdmission{}, err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return InviteAdmission{}, err
	}
	if !state.PolicyAnchored {
		return InviteAdmission{}, ChannelRestricted
	}
	for _, profile := range []string{applicant.ProfileID, applicant.BoundProfile} {
		if removal := state.MemberRemovals[profile]; removal.BannedAt(s.now().UnixMilli()) {
			return InviteAdmission{}, MemberBanError{removal}
		}
	}
	head, err := ReadPolicyHead(ctx, tx, nil)
	if err != nil {
		return InviteAdmission{}, err
	}
	if err := verifyPolicy(ctx, tx, head.Principal, head.Draft); err != nil {
		return InviteAdmission{}, err
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return InviteAdmission{}, err
	}
	requestHash := sha256.Sum256(raw)
	requestDigest := hex.EncodeToString(requestHash[:])
	result := InviteAdmission{ProfileID: applicant.ProfileID, DeviceID: applicant.DeviceID, KeysPending: true}
	var priorDevice, priorOperation, priorDigest string
	err = tx.QueryRowContext(ctx, `SELECT invite_id,device_id,operation_id,request_digest,accepted_at FROM protected_invite_admissions WHERE profile_id=?`,
		applicant.ProfileID).Scan(&result.InviteID, &priorDevice, &priorOperation, &priorDigest, &result.AcceptedAt)
	hadReceipt := err == nil
	if hadReceipt && result.InviteID == input.InviteID && priorDevice == applicant.DeviceID &&
		priorOperation == input.OperationID && priorDigest == requestDigest {
		if state.PolicyDevices[applicant.DeviceID].Revoked {
			return InviteAdmission{}, ChannelRestricted
		}
		result.Existing = true
		if enrollment != nil && state.PolicyDevices[applicant.DeviceID].ProfileID == "" {
			witness, err := ReadPendingInviteAdmission(ctx, tx, applicant.DeviceID, s.now().UnixMilli(), authenticate, verifyIssue, verifyPolicy)
			if err != nil {
				return InviteAdmission{}, err
			}
			if err := s.commitRedeemedInvite(ctx, tx, state, revision, head, applicant.Principal, requestDigest, input,
				witness.Issuance, *enrollment, verifyPolicy); err != nil {
				return InviteAdmission{}, err
			}
			if err := tx.Commit(); err != nil {
				return InviteAdmission{}, err
			}
		}
		return result, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return InviteAdmission{}, err
	}
	device := state.PolicyDevices[applicant.DeviceID]
	if state.Members[applicant.ProfileID].Active || state.Members[applicant.BoundProfile].Active ||
		(device.ProfileID != "" && (device.ProfileID != applicant.ProfileID || !device.Revoked)) ||
		(hadReceipt && state.PolicyDevices[priorDevice].ProfileID != applicant.ProfileID) {
		return InviteAdmission{}, ErrInviteConflict
	}
	var issuer Principal
	issue := InviteCreate{ID: input.InviteID}
	var createdAt, expiresAt, maxUses, uses int64
	var revokedAt sql.NullInt64
	err = tx.QueryRowContext(ctx, `SELECT creator_profile_id,creator_device_id,token_hash,requested_expiry,policy_digest,signature,
		created_at,expires_at,max_uses,uses,revoked_at FROM protected_invites WHERE id=?`, input.InviteID).
		Scan(&issuer.ProfileID, &issuer.DeviceID, &issue.TokenHash, &issue.ExpiresAt, &issue.PolicyDigest, &issue.Signature,
			&createdAt, &expiresAt, &maxUses, &uses, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return InviteAdmission{}, ErrInviteUnavailable
	}
	if err != nil {
		return InviteAdmission{}, err
	}
	now := s.now().UnixMilli()
	if subtle.ConstantTimeCompare([]byte(issue.TokenHash), []byte(applicant.TokenHash)) != 1 || revokedAt.Valid || expiresAt <= now ||
		(maxUses != 0 && uses >= maxUses) {
		return InviteAdmission{}, ErrInviteUnavailable
	}
	expectedExpiry := issue.ExpiresAt
	if expectedExpiry == 0 {
		expectedExpiry = createdAt + millisecondsPerDay
	}
	if expiresAt != expectedExpiry || expiresAt > maxInviteDate || createdAt > now || maxUses > maxInviteUseLimit || uses >= maxInviteUseLimit {
		return InviteAdmission{}, ErrInviteUnavailable
	}
	issueRevision, err := verifyInviteAuthority(ctx, tx, issuer, issue, maxUses, createdAt, verifyIssue, verifyPolicy)
	if err != nil {
		return InviteAdmission{}, err
	}
	updated, err := tx.ExecContext(ctx, `UPDATE protected_invites SET uses=uses+1 WHERE id=? AND revoked_at IS NULL AND expires_at>?
		AND (max_uses=0 OR uses<max_uses)`, input.InviteID, now)
	if err != nil {
		return InviteAdmission{}, err
	}
	if rows, err := updated.RowsAffected(); err != nil {
		return InviteAdmission{}, err
	} else if rows != 1 {
		return InviteAdmission{}, ErrInviteUnavailable
	}
	if hadReceipt {
		if _, err := tx.ExecContext(ctx, "DELETE FROM protected_pending_invite_sessions WHERE device_id=?", priorDevice); err != nil {
			return InviteAdmission{}, err
		}
	}
	stored, err := tx.ExecContext(ctx, `INSERT INTO protected_invite_admissions(profile_id,device_id,invite_id,operation_id,request_digest,request,accepted_at)
		VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET device_id=excluded.device_id,invite_id=excluded.invite_id,
		operation_id=excluded.operation_id,request_digest=excluded.request_digest,request=excluded.request,accepted_at=excluded.accepted_at`,
		applicant.ProfileID, applicant.DeviceID, input.InviteID, input.OperationID, requestDigest, raw, now)
	if err != nil {
		return InviteAdmission{}, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO protected_invite_device_keys(device_id,public_key) VALUES(?,?)",
		applicant.DeviceID, input.DevicePublicKey); err != nil {
		return InviteAdmission{}, err
	}
	if rows, err := stored.RowsAffected(); err != nil {
		return InviteAdmission{}, err
	} else if rows != 1 {
		return InviteAdmission{}, ErrInviteConflict
	}
	if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: applicant.ProfileID, Action: "invite.accept", Kind: "invite", ObjectID: input.InviteID}); err != nil {
		return InviteAdmission{}, err
	}
	if enrollment != nil {
		witness := InviteIssuance{Issuer: issuer, PolicyRevision: issueRevision, PolicyDigest: issue.PolicyDigest,
			RequestedExpiry: issue.ExpiresAt, CreatedAt: createdAt, ExpiresAt: expiresAt, AcceptedAt: now,
			MaxUses: maxUses, Signature: base64.StdEncoding.EncodeToString(issue.Signature)}
		if err := s.commitRedeemedInvite(ctx, tx, state, revision, head, applicant.Principal, requestDigest, input,
			witness, *enrollment, verifyPolicy); err != nil {
			return InviteAdmission{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return InviteAdmission{}, err
	}
	result.InviteID = input.InviteID
	result.AcceptedAt = now
	return result, nil
}

func (s *Store) commitRedeemedInvite(ctx context.Context, tx *sql.Tx, state State, revision int64, head PolicyProof,
	actor Principal, requestDigest string, claim InviteRedeem, witness InviteIssuance, enrollment InviteEnrollment, verify VerifyPolicyDraft) error {
	var seed string
	if head.Draft.TextProjectionSeed != "" {
		var randomSeed [32]byte
		if _, err := rand.Read(randomSeed[:]); err != nil {
			return err
		}
		seed = hex.EncodeToString(randomSeed[:])
	}
	draft, err := preparePolicyDraft(&state, revision, head, actor, PolicyDraft{Action: RedeemPolicyInvite,
		OperationID: requestDigest[:32], TextProjectionSeed: seed, TextProjectionVersion: head.Draft.TextProjectionVersion,
		ResourceChange: &PolicyResourceChange{ID: actor.ProfileID, Admission: &InvitePolicyAdmission{
			CutoverDigest: enrollment.CutoverDigest, Claim: claim, Issuance: &witness, ServerKey: enrollment.ServerKey,
		}}})
	if err != nil {
		return err
	}
	draft.Signature, err = enrollment.Sign(ctx, tx, actor, draft)
	if err != nil {
		return err
	}
	proof, err := s.commitPolicyInTransaction(ctx, tx, actor, verify, draft, nil)
	if err != nil || !supportsScopedInviteReceipts(draft.TextProjectionVersion) {
		return err
	}
	return storeScopedInviteReceipt(ctx, tx, proof, enrollment.SignReceipt)
}

func VerifyAdmissionIssuance(ctx context.Context, query SessionQuery, admission InvitePolicyAdmission, revision int64,
	verifyIssue VerifyInviteCreate, verifyPolicy VerifyPolicyDraft) error {
	evidence := admission.Issuance
	if evidence == nil || evidence.PolicyRevision < 1 || evidence.PolicyRevision >= revision ||
		evidence.CreatedAt < 1 || evidence.ExpiresAt > maxInviteDate || evidence.RequestedExpiry < 0 ||
		evidence.MaxUses < 0 || evidence.MaxUses > maxInviteUseLimit ||
		evidence.AcceptedAt < evidence.CreatedAt || evidence.AcceptedAt >= evidence.ExpiresAt {
		return ErrInviteUnavailable
	}
	expiry := evidence.RequestedExpiry
	if expiry == 0 {
		expiry = evidence.CreatedAt + millisecondsPerDay
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(evidence.Signature)
	tokenKey, valid := inviteClaimKey(admission.Claim.InvitePublicKey)
	if expiry != evidence.ExpiresAt || !valid || err != nil || len(signature) != 64 ||
		base64.StdEncoding.EncodeToString(signature) != evidence.Signature {
		return ErrInviteUnavailable
	}
	issue := InviteCreate{ID: admission.Claim.InviteID, TokenHash: hexHash(tokenKey), ExpiresAt: evidence.RequestedExpiry,
		PolicyDigest: evidence.PolicyDigest, Signature: signature}
	actualRevision, err := verifyInviteAuthority(ctx, query, evidence.Issuer, issue, evidence.MaxUses, evidence.CreatedAt, verifyIssue, verifyPolicy)
	if err != nil {
		return err
	}
	if actualRevision != evidence.PolicyRevision {
		return ErrInviteUnavailable
	}
	return nil
}

func verifyInviteAuthority(ctx context.Context, tx SessionQuery, issuer Principal, issue InviteCreate, maxUses, createdAt int64,
	verifyIssue VerifyInviteCreate, verifyPolicy VerifyPolicyDraft) (int64, error) {
	snapshot, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy_proofs WHERE digest=?", issue.PolicyDigest))
	if err != nil {
		return 0, err
	}
	proof, err := readAttestedProof(ctx, tx, revision)
	if err != nil {
		return 0, err
	}
	if proof.Digest != issue.PolicyDigest {
		return 0, ErrInviteUnavailable
	}
	// Stored policy proof snapshots omit the runtime anchor flag. The proof
	// and snapshot digest are verified before using the historical grants.
	snapshot.PolicyAnchored = true
	if err := checkPolicyHead(snapshot, revision, proof); err != nil {
		return 0, err
	}
	if err := verifyPolicy(ctx, tx, proof.Principal, proof.Draft); err != nil {
		return 0, err
	}
	if !snapshot.inviteGrants(issuer, createdAt).own {
		return 0, ErrInviteUnavailable
	}
	if err := verifyIssue(ctx, tx, issuer, issue, maxUses); err != nil {
		return 0, err
	}
	return revision, nil
}
