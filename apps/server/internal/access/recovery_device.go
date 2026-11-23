package access

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"reflect"
)

const RecoverPolicyDevice = "recovery.device"

// RecoveryPolicyDevice binds the new device to the existing effective
// profile. It contains only public keys, challenge fields and proofs.
type RecoveryPolicyDevice struct {
	RecoveryID     string
	CutoverDigest  string
	ServerKey      string
	Nonce          string
	ExpiresAt      int64
	SigningKey     string
	AgreementKey   string
	RecoveryProof  string
	AgreementProof string
	DeviceProof    string
	ScopeAuthority *ScopeAuthorityLink `json:",omitempty"`
}

func recoveryDeviceActor(change *PolicyResourceChange) (Principal, error) {
	if change == nil || change.RecoveryDevice == nil {
		return Principal{}, InvalidAction
	}
	input := change.RecoveryDevice
	if *change != (PolicyResourceChange{ID: change.ID, RecoveryDevice: input}) || !isDigest(change.ID) ||
		!isDigest(input.RecoveryID) || !isDigest(input.CutoverDigest) || !isDigest(input.Nonce) ||
		input.ExpiresAt <= 0 || input.ExpiresAt > maxInviteDate || !isDigest(input.SigningKey) ||
		!validRecipientKey(input.AgreementKey) || input.SigningKey == input.AgreementKey ||
		!validRecoveryProof(input.ServerKey, 32) || !validRecoveryProof(input.RecoveryProof, 64) ||
		!validRecoveryProof(input.AgreementProof, 32) || !validRecoveryProof(input.DeviceProof, 64) {
		return Principal{}, InvalidAction
	}
	signingKey, _ := hex.DecodeString(input.SigningKey)
	if !ValidRecoveryEpochOpeningKey(signingKey) {
		return Principal{}, InvalidAction
	}
	return Principal{ProfileID: change.ID, DeviceID: hexHash(signingKey)}, nil
}

func (s State) recoveryDeviceIdentity(profile string, now int64) (RecoveryIdentity, error) {
	if !s.PolicyAnchored {
		return RecoveryIdentity{}, Inactive
	}
	if removal := s.MemberRemovals[profile]; removal.BannedAt(now) {
		return RecoveryIdentity{}, MemberBanError{removal}
	}
	if !s.Members[profile].Active {
		return RecoveryIdentity{}, Inactive
	}
	identity := s.RecoveryIdentities[profile]
	if identity.ID == "" || s.KeyRecipients[identity.ID] != (KeyRecipient{
		ProfileID: profile, Kind: "recovery", PublicKey: identity.AgreementKey,
	}) {
		return RecoveryIdentity{}, ErrRecipientKey
	}
	if profile == s.Owner && !s.RecoveryReady[profile] {
		return RecoveryIdentity{}, RecoveryRequired
	}
	return identity, nil
}

// ReadRecoveryDeviceTarget is for the authenticated proof verifier. It
// checks the existing member without requiring any of the lost devices.
func ReadRecoveryDeviceTarget(ctx context.Context, query SessionQuery, profile string, now int64) (RecoveryIdentity, error) {
	state, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return RecoveryIdentity{}, err
	}
	return state.recoveryDeviceIdentity(profile, now)
}

func (s State) checkRecoveryDevice(actor Principal, change *PolicyResourceChange) (RecoveryIdentity, error) {
	expected, err := recoveryDeviceActor(change)
	if err != nil || expected != actor {
		return RecoveryIdentity{}, InvalidAction
	}
	// Replay receives a signed antecedent, not a live clock or lease. An
	// applied ban leaves the member inactive until explicit readmission.
	identity, err := s.recoveryDeviceIdentity(actor.ProfileID, 0)
	if err != nil {
		return RecoveryIdentity{}, err
	}
	input := change.RecoveryDevice
	if identity.ID != input.RecoveryID {
		return RecoveryIdentity{}, ErrPolicyConflict
	}
	if err := s.checkNewDeviceKeys(actor.DeviceID, input.SigningKey, input.AgreementKey); err != nil {
		return RecoveryIdentity{}, err
	}
	return identity, nil
}

func (s *State) applyRecoveryDevice(actor Principal, change PolicyResourceChange) error {
	if _, err := s.checkRecoveryDevice(actor, &change); err != nil {
		return err
	}
	s.retirePolicyDevices(actor.ProfileID)
	if s.PolicyDevices == nil {
		s.PolicyDevices = make(map[string]PolicyDevice)
	}
	s.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: actor.ProfileID, PublicKey: change.RecoveryDevice.SigningKey}
	return s.changeRecipientKey(actor, EnrollRecipientKey, change.RecoveryDevice.AgreementKey)
}

// ReadRecoveryDeviceIdentity verifies the exact immutable predecessor used
// by the signed device recovery, even after the current identity is replaced.
func ReadRecoveryDeviceIdentity(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) (RecoveryIdentity, error) {
	if draft.Action != RecoverPolicyDevice {
		return RecoveryIdentity{}, InvalidAction
	}
	state, _, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return RecoveryIdentity{}, err
	}
	return state.checkRecoveryDevice(actor, draft.ResourceChange)
}

// CommitRecoveryDevice exchanges the member's recovery proofs for one new
// device and synchronizes membership/session storage in the same transaction.
// Receipt retries never perform the synchronization again.
func (s *Store) CommitRecoveryDevice(ctx context.Context, intent PolicyDraft, verifyIntent VerifyPolicyDraft,
	sign SignServerPolicyDraft, verify VerifyPolicyDraft, syncMembership func(context.Context, *sql.Tx, Principal) error) (PolicyProof, error) {
	if intent.Action != RecoverPolicyDevice || !validRecoveryIntentFields(intent) ||
		verifyIntent == nil || sign == nil || verify == nil || syncMembership == nil {
		return PolicyProof{}, InvalidAction
	}
	actor, err := recoveryDeviceActor(intent.ResourceChange)
	if err != nil {
		return PolicyProof{}, err
	}
	input := intent.ResourceChange.RecoveryDevice
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	defer tx.Rollback()
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return PolicyProof{}, err
	}
	identity, err := state.recoveryDeviceIdentity(actor.ProfileID, s.now().UnixMilli())
	if err != nil {
		return PolicyProof{}, err
	}
	if identity.ID != input.RecoveryID {
		return PolicyProof{}, ErrRecipientKey
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
		if prior.Principal != actor || prior.Draft.Action != intent.Action || prior.Draft.PreviousDigest != intent.PreviousDigest ||
			!reflect.DeepEqual(prior.Draft.ResourceChange, intent.ResourceChange) {
			return PolicyProof{}, ErrPolicyConflict
		}
		if !state.hasPolicyDevice(actor) || state.PolicyDevices[actor.DeviceID].PublicKey != input.SigningKey ||
			state.KeyRecipients[actor.DeviceID] != (KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: input.AgreementKey}) {
			return PolicyProof{}, Inactive
		}
		// Reauthenticate the request against current account restrictions.
		// The exact receipt remains valid even when its challenge is old.
		if err := verifyIntent(ctx, tx, actor, prior.Draft); err != nil {
			return PolicyProof{}, err
		}
		return prior, verify(ctx, tx, prior.Principal, prior.Draft)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, err
	}
	if intent.PreviousDigest != head.Digest {
		return PolicyProof{}, ErrPolicyConflict
	}
	if input.ExpiresAt <= s.now().UnixMilli() {
		return PolicyProof{}, ErrRecoveryChallengeExpired
	}
	if err := verifyIntent(ctx, tx, actor, intent); err != nil {
		return PolicyProof{}, err
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
	if err := syncMembership(ctx, tx, actor); err != nil {
		return PolicyProof{}, err
	}
	if input.ExpiresAt <= s.now().UnixMilli() {
		return PolicyProof{}, ErrRecoveryChallengeExpired
	}
	if err := tx.Commit(); err != nil {
		return PolicyProof{}, err
	}
	return proof, nil
}
