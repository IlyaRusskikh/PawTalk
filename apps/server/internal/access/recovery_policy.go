package access

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
)

const EnrollPolicyRecovery = "recovery.enroll"

var ErrRecoveryChallengeExpired = errors.New("protected recovery challenge expired")
var ErrRecoveryKeyRetired = fmt.Errorf("protected recovery key retired: %w", ErrRecipientKey)

type RecoveryIdentity struct {
	ID           string
	SigningKey   string
	AgreementKey string
}

// RecoveryPolicyEnrollment contains public identity and proof material only.
// The seed, private keys and server challenge secret are outside policy.
type RecoveryPolicyEnrollment struct {
	RecoveryID         string
	SigningKey         string
	AgreementKey       string
	CutoverDigest      string
	ServerKey          string
	Nonce              string
	ExpiresAt          int64
	ServerAgreementKey string
	RecoveryProof      string
	AgreementProof     string
	DeviceProof        string
	ScopeAuthority     *ScopeAuthorityLink `json:",omitempty"`
}

func validRecoveryProof(value string, size int) bool {
	if len(value) != base64.RawURLEncoding.EncodedLen(size) {
		return false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(raw) == size
}

func (enrollment RecoveryPolicyEnrollment) valid() bool {
	return isDigest(enrollment.RecoveryID) && isDigest(enrollment.SigningKey) && enrollment.SigningKey != zeroKey &&
		validRecipientKey(enrollment.AgreementKey) && enrollment.SigningKey != enrollment.AgreementKey &&
		isDigest(enrollment.CutoverDigest) && isDigest(enrollment.Nonce) &&
		enrollment.ExpiresAt > 0 && enrollment.ExpiresAt <= maxInviteDate &&
		validRecipientKey(enrollment.ServerAgreementKey) && validRecoveryProof(enrollment.ServerKey, 32) &&
		validRecoveryProof(enrollment.RecoveryProof, 64) && validRecoveryProof(enrollment.AgreementProof, 32) &&
		validRecoveryProof(enrollment.DeviceProof, 64)
}

func (s State) validRecoveryIdentities() bool {
	seenSigners := make(map[string]bool, len(s.RecoveryIdentities))
	for profile, identity := range s.RecoveryIdentities {
		recipient := s.KeyRecipients[identity.ID]
		if !s.Members[profile].Active || !isDigest(identity.ID) || !isDigest(identity.SigningKey) || identity.SigningKey == zeroKey ||
			identity.SigningKey == identity.AgreementKey || seenSigners[identity.SigningKey] ||
			s.RetiredRecoverySigningKeys[identity.SigningKey] ||
			recipient != (KeyRecipient{ProfileID: profile, Kind: "recovery", PublicKey: identity.AgreementKey}) {
			return false
		}
		seenSigners[identity.SigningKey] = true
	}
	return true
}

func (s *State) retireRecoveryIdentity(profile string) {
	identity, hasIdentity := s.RecoveryIdentities[profile]
	if hasIdentity {
		if s.RetiredRecoverySigningKeys == nil {
			s.RetiredRecoverySigningKeys = make(map[string]bool)
		}
		s.RetiredRecoverySigningKeys[identity.SigningKey] = true
		delete(s.RecoveryIdentities, profile)
	}
	for id, recipient := range s.KeyRecipients {
		if recipient.ProfileID != profile || recipient.Kind != "recovery" {
			continue
		}
		if s.RetiredRecipientKeys == nil {
			s.RetiredRecipientKeys = make(map[string]bool)
		}
		s.RetiredRecipientKeys[recipient.PublicKey] = true
		delete(s.KeyRecipients, id)
	}
	delete(s.RecoveryReady, profile)
}

func (s *State) applyRecoveryEnrollment(actor Principal, change PolicyResourceChange) error {
	profile, enrollment := actor.ProfileID, change.Recovery
	if enrollment == nil || change != (PolicyResourceChange{ID: profile, Recovery: enrollment}) || !enrollment.valid() {
		return InvalidAction
	}
	if !s.hasPolicyDevice(actor) || !s.Members[profile].Active {
		return Inactive
	}
	if removal := s.MemberRemovals[profile]; removal.Action == BanPolicyMember && !removal.Lifted {
		return MemberBanError{removal}
	}
	if s.RetiredRecipientKeys[enrollment.AgreementKey] || s.RetiredRecoverySigningKeys[enrollment.SigningKey] {
		return ErrRecoveryKeyRetired
	}
	if s.KeyRecipients[enrollment.RecoveryID].Kind != "" || s.PolicyDevices[enrollment.RecoveryID].ProfileID != "" {
		return ErrRecipientKey
	}
	for _, recipient := range s.KeyRecipients {
		if recipient.PublicKey == enrollment.AgreementKey || recipient.PublicKey == enrollment.SigningKey {
			return ErrRecipientKey
		}
	}
	for _, device := range s.PolicyDevices {
		if device.PublicKey == enrollment.SigningKey || device.PublicKey == enrollment.AgreementKey {
			return ErrRecipientKey
		}
	}
	for _, identity := range s.RecoveryIdentities {
		if identity.SigningKey == enrollment.SigningKey || identity.SigningKey == enrollment.AgreementKey {
			return ErrRecipientKey
		}
	}
	s.retireRecoveryIdentity(profile)
	if s.RecoveryIdentities == nil {
		s.RecoveryIdentities = make(map[string]RecoveryIdentity)
	}
	s.RecoveryIdentities[profile] = RecoveryIdentity{
		ID: enrollment.RecoveryID, SigningKey: enrollment.SigningKey, AgreementKey: enrollment.AgreementKey,
	}
	if s.KeyRecipients == nil {
		s.KeyRecipients = make(map[string]KeyRecipient)
	}
	s.KeyRecipients[enrollment.RecoveryID] = KeyRecipient{ProfileID: profile, Kind: "recovery", PublicKey: enrollment.AgreementKey}
	return nil
}

// CommitRecoveryEnrollment applies the active member's exact approved intent
// without disclosing the whole policy. First use validates the time-limited
// agreement challenge in the same transaction as the signed transition.
func (s *Store) CommitRecoveryEnrollment(ctx context.Context, resolve ResolveSession, intent PolicyDraft,
	verifyIntent VerifyPolicyDraft, sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	if intent.Action != EnrollPolicyRecovery || intent.ResourceChange == nil ||
		intent.ResourceChange.Recovery == nil || !intent.ResourceChange.Recovery.valid() {
		return PolicyProof{}, InvalidAction
	}
	if change := *intent.ResourceChange; change != (PolicyResourceChange{ID: change.ID, Recovery: change.Recovery}) {
		return PolicyProof{}, InvalidAction
	}
	return s.commitVerifiedMemberTransition(ctx, resolve, intent, intent.ResourceChange.Recovery.ExpiresAt, verifyIntent, sign, verify, nil)
}

func (s *Store) commitVerifiedMemberTransition(ctx context.Context, resolve ResolveSession, intent PolicyDraft, expiresAt int64,
	verifyIntent VerifyPolicyDraft, sign SignServerPolicyDraft, verify VerifyPolicyDraft, verifyEpoch VerifyEpochRecord) (PolicyProof, error) {
	if resolve == nil || verifyIntent == nil || sign == nil || verify == nil || !validRecoveryIntentFields(intent) {
		return PolicyProof{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return PolicyProof{}, err
	}
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
		return PolicyProof{}, Inactive
	}
	if removal := state.MemberRemovals[actor.ProfileID]; removal.BannedAt(s.now().UnixMilli()) {
		return PolicyProof{}, MemberBanError{removal}
	}
	if intent.ResourceChange.ID != actor.ProfileID {
		return PolicyProof{}, InvalidAction
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	if err := checkPolicyHead(state, revision, head); err != nil {
		return PolicyProof{}, err
	}
	if err := verify(ctx, tx, head.Principal, head.Draft); err != nil {
		return PolicyProof{}, err
	}
	prior, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx,
		"SELECT revision,operation_id,digest,record FROM protected_policy_proofs WHERE operation_id=?", intent.OperationID))
	if err == nil {
		change := prior.Draft.ResourceChange
		if prior.Draft.Action == BindPolicyDevice && change != nil && change.DeviceBinding != nil {
			unsigned, binding := *change, *change.DeviceBinding
			binding.RebindAt = 0
			unsigned.DeviceBinding = &binding
			change = &unsigned
		}
		if prior.Principal != actor || prior.Draft.Action != intent.Action || prior.Draft.PreviousDigest != intent.PreviousDigest ||
			!reflect.DeepEqual(change, intent.ResourceChange) {
			return PolicyProof{}, ErrPolicyConflict
		}
		if binding := intent.ResourceChange.DeviceBinding; binding != nil {
			applicant, err := deviceBindingApplicant(intent.ResourceChange)
			if err != nil || !state.matchesDeviceBinding(applicant, *binding) {
				return PolicyProof{}, Inactive
			}
		}
		return prior, verify(ctx, tx, prior.Principal, prior.Draft)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, err
	}
	if intent.PreviousDigest != head.Digest {
		return PolicyProof{}, ErrPolicyConflict
	}
	now := s.now().UnixMilli()
	if expiresAt <= now {
		return PolicyProof{}, ErrRecoveryChallengeExpired
	}
	if intent.Action == BindPolicyDevice {
		applicant, err := deviceBindingApplicant(intent.ResourceChange)
		if err != nil {
			return PolicyProof{}, err
		}
		if state.DetachedPolicyDevices[applicant.DeviceID] != "" {
			change, binding := *intent.ResourceChange, *intent.ResourceChange.DeviceBinding
			binding.RebindAt = now
			change.DeviceBinding = &binding
			intent.ResourceChange = &change
		}
	}
	if err := verifyIntent(ctx, tx, actor, intent); err != nil {
		return PolicyProof{}, err
	}
	if confirmation := intent.ResourceChange.RecoveryConfirmation; confirmation != nil {
		var serverID string
		if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
			return PolicyProof{}, err
		}
		if err := VerifyRecoveryConfirmationEvidence(ctx, tx, state, actor, head, serverID, *confirmation, verifyEpoch, s.now().UnixMilli(), true); err != nil {
			return PolicyProof{}, err
		}
	}
	intent.TextProjectionVersion = head.Draft.TextProjectionVersion
	if head.Draft.TextProjectionSeed != "" {
		var seed [32]byte
		if _, err := rand.Read(seed[:]); err != nil {
			return PolicyProof{}, err
		}
		intent.TextProjectionSeed = hex.EncodeToString(seed[:])
	}
	draft, err := preparePolicyDraft(&state, revision, head, actor, intent)
	if err != nil {
		return PolicyProof{}, err
	}
	draft.Signature, err = sign(ctx, tx, actor, draft)
	if err != nil {
		return PolicyProof{}, err
	}
	proof, err := s.commitPolicyInTransaction(ctx, tx, actor, verify, draft, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	if expiresAt <= s.now().UnixMilli() {
		return PolicyProof{}, ErrRecoveryChallengeExpired
	}
	if err := tx.Commit(); err != nil {
		return PolicyProof{}, err
	}
	return proof, nil
}

func validRecoveryIntentFields(intent PolicyDraft) bool {
	return validRotationID(intent.OperationID) && isDigest(intent.PreviousDigest) &&
		intent.Revision == 0 && intent.ResultDigest == "" && intent.TextProjectionRoot == "" &&
		intent.TextProjectionSeed == "" && intent.TextProjectionVersion == 0 && intent.PublicKey == "" &&
		intent.RoleUpdate == nil && intent.DeviceChange == nil && len(intent.Signature) == 0
}
