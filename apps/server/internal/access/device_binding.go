package access

import (
	"context"
	"crypto/ed25519"
	"database/sql"
)

const BindPolicyDevice = "device.bind"

// PolicyDeviceBinding carries the public keys and both devices' proofs.
// The new device is registered on the approver's effective profile.
type PolicyDeviceBinding struct {
	SigningKey         string
	AgreementKey       string
	CutoverDigest      string
	Nonce              string
	ExpiresAt          int64
	ServerAgreementKey string
	AgreementProof     string
	ApplicantProof     string
	ApproverProof      string
	ServerKey          string
	RebindAt           int64 `json:",omitempty"`
}

func deviceBindingApplicant(change *PolicyResourceChange) (Principal, error) {
	if change == nil || change.DeviceBinding == nil {
		return Principal{}, InvalidAction
	}
	binding := change.DeviceBinding
	if *change != (PolicyResourceChange{ID: change.ID, DeviceBinding: binding}) || !isDigest(change.ID) ||
		!isDigest(binding.CutoverDigest) || !isDigest(binding.Nonce) || binding.ExpiresAt <= 0 || binding.ExpiresAt > maxInviteDate ||
		(binding.RebindAt != 0 && !validProfileLinkTime(binding.RebindAt, binding.ExpiresAt)) ||
		!validRecipientKey(binding.AgreementKey) || !validRecipientKey(binding.ServerAgreementKey) || binding.SigningKey == binding.AgreementKey ||
		!validRecoveryProof(binding.ServerKey, ed25519.PublicKeySize) || !validRecoveryProof(binding.AgreementProof, 32) ||
		!validRecoveryProof(binding.ApplicantProof, ed25519.SignatureSize) || !validRecoveryProof(binding.ApproverProof, ed25519.SignatureSize) {
		return Principal{}, InvalidAction
	}
	signingKey := parseScopeAuthorityKey(binding.SigningKey)
	if signingKey == nil {
		return Principal{}, InvalidAction
	}
	return Principal{ProfileID: change.ID, DeviceID: hexHash(signingKey)}, nil
}

func (s State) checkDeviceBinding(approver Principal, change *PolicyResourceChange) (Principal, error) {
	applicant, err := deviceBindingApplicant(change)
	if err != nil || applicant.ProfileID != approver.ProfileID {
		return Principal{}, InvalidAction
	}
	if !s.PolicyAnchored || !s.Members[approver.ProfileID].Active || !s.hasPolicyDevice(approver) {
		return Principal{}, Inactive
	}
	binding := change.DeviceBinding
	if binding.RebindAt == 0 {
		if removal := s.MemberRemovals[approver.ProfileID]; removal.BannedAt(0) {
			return Principal{}, MemberBanError{removal}
		}
		if err := s.checkNewDeviceKeys(applicant.DeviceID, binding.SigningKey, binding.AgreementKey); err != nil {
			return Principal{}, err
		}
		return applicant, nil
	}
	if err := s.checkDetachedDeviceRebind(applicant, *binding); err != nil {
		return Principal{}, err
	}
	return applicant, nil
}

func (s State) checkDetachedDeviceRebind(applicant Principal, binding PolicyDeviceBinding) error {
	source := s.DetachedPolicyDevices[applicant.DeviceID]
	device := s.PolicyDevices[applicant.DeviceID]
	if source == "" || source == applicant.ProfileID || s.Members[source].ID != source || s.Members[source].Active ||
		device != (PolicyDevice{ProfileID: source, PublicKey: binding.SigningKey, Revoked: true}) ||
		(s.ProfileBindings[source] != "" && s.ProfileBindings[source] != applicant.ProfileID) {
		return ErrRecipientKey
	}
	if err := s.profileGroupBan(applicant.ProfileID, binding.RebindAt); err != nil {
		return err
	}
	if err := s.profileGroupBan(source, binding.RebindAt); err != nil {
		return err
	}
	return s.checkDeviceKeyConflicts(applicant.DeviceID, binding.SigningKey, binding.AgreementKey, applicant.DeviceID)
}

func (s State) validDetachedPolicyDevices() bool {
	for id, source := range s.DetachedPolicyDevices {
		device := s.PolicyDevices[id]
		if !isDigest(source) || s.Members[source].ID != source || s.Members[source].Active ||
			!device.Revoked || device.ProfileID != source || !signingKeyMatches(id, device.PublicKey) ||
			s.ProfileDeviceOrigins[id] != "" || s.KeyRecipients[id].Kind != "" {
			return false
		}
	}
	return true
}

func (s *State) clearDetachedPolicyDevices(source string) {
	for id, origin := range s.DetachedPolicyDevices {
		if origin == source {
			delete(s.DetachedPolicyDevices, id)
		}
	}
	if len(s.DetachedPolicyDevices) == 0 {
		s.DetachedPolicyDevices = nil
	}
}

// checkNewDeviceKeys rejects reuse across recipient and signing roles,
// including keys belonging to devices already retired by policy.
func (s State) checkNewDeviceKeys(deviceID, signingKey, agreementKey string) error {
	if _, exists := s.PolicyDevices[deviceID]; exists {
		return ErrRecipientKey
	}
	return s.checkDeviceKeyConflicts(deviceID, signingKey, agreementKey, "")
}

func (s State) checkDeviceKeyConflicts(deviceID, signingKey, agreementKey, existingSigningDevice string) error {
	if _, exists := s.KeyRecipients[deviceID]; exists {
		return ErrRecipientKey
	}
	if s.RetiredRecipientKeys[signingKey] || s.RetiredRecipientKeys[agreementKey] ||
		s.RetiredRecoverySigningKeys[signingKey] || s.RetiredRecoverySigningKeys[agreementKey] {
		return ErrRecipientKey
	}
	reused := func(key string) bool { return key == signingKey || key == agreementKey }
	for _, recipient := range s.KeyRecipients {
		if reused(recipient.PublicKey) {
			return ErrRecipientKey
		}
	}
	for id, device := range s.PolicyDevices {
		if id != existingSigningDevice && reused(device.PublicKey) {
			return ErrRecipientKey
		}
	}
	for _, recovery := range s.RecoveryIdentities {
		if reused(recovery.SigningKey) {
			return ErrRecipientKey
		}
	}
	return nil
}

func (s *State) applyDeviceBinding(approver Principal, change *PolicyResourceChange) error {
	applicant, err := s.checkDeviceBinding(approver, change)
	if err != nil {
		return err
	}
	if change.DeviceBinding.RebindAt != 0 {
		source := s.DetachedPolicyDevices[applicant.DeviceID]
		delete(s.DetachedPolicyDevices, applicant.DeviceID)
		if len(s.DetachedPolicyDevices) == 0 {
			s.DetachedPolicyDevices = nil
		}
		if s.ProfileBindings == nil {
			s.ProfileBindings = make(map[string]string)
		}
		if s.ProfileDeviceOrigins == nil {
			s.ProfileDeviceOrigins = make(map[string]string)
		}
		s.ProfileBindings[source] = approver.ProfileID
		s.ProfileDeviceOrigins[applicant.DeviceID] = source
	}
	s.PolicyDevices[applicant.DeviceID] = PolicyDevice{ProfileID: applicant.ProfileID, PublicKey: change.DeviceBinding.SigningKey}
	return s.changeRecipientKey(applicant, EnrollRecipientKey, change.DeviceBinding.AgreementKey)
}

// ReadDeviceBindingDetachedSource returns the signed origin for an explicitly
// detached device. Callers still check the signed transition and current bans.
func ReadDeviceBindingDetachedSource(ctx context.Context, query SessionQuery, deviceID string) (string, error) {
	if !isDigest(deviceID) {
		return "", InvalidAction
	}
	state, _, err := readCommittedPolicyState(ctx, query)
	if err != nil {
		return "", err
	}
	return state.DetachedPolicyDevices[deviceID], nil
}

// ReadDeviceBindingReceipt matches the applicant to a committed operation
// and the same active device and agreement recipient in current signed policy.
func ReadDeviceBindingReceipt(ctx context.Context, query SessionQuery, applicant Principal, operationID string) (PolicyProof, error) {
	if !validRotationID(operationID) || !isDigest(applicant.DeviceID) || !isDigest(applicant.ProfileID) {
		return PolicyProof{}, InvalidAction
	}
	proof, err := readStoredPolicyProof(ctx, query, query.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE operation_id=?`, operationID))
	if err != nil {
		return PolicyProof{}, err
	}
	if proof.Draft.Action != BindPolicyDevice {
		return PolicyProof{}, ErrPolicyConflict
	}
	bound, err := deviceBindingApplicant(proof.Draft.ResourceChange)
	if err != nil || bound.ProfileID != proof.Principal.ProfileID || bound.DeviceID != applicant.DeviceID {
		return PolicyProof{}, ErrPolicyConflict
	}
	state, _, err := readCommittedPolicyState(ctx, query)
	if err != nil {
		return PolicyProof{}, err
	}
	if device := state.PolicyDevices[applicant.DeviceID]; !device.Revoked && device.ProfileID != applicant.ProfileID {
		return PolicyProof{}, ErrPolicyConflict
	}
	if !state.matchesDeviceBinding(applicant, *proof.Draft.ResourceChange.DeviceBinding) {
		return PolicyProof{}, Inactive
	}
	return proof, nil
}

func (s State) matchesDeviceBinding(applicant Principal, binding PolicyDeviceBinding) bool {
	return s.PolicyAnchored && s.Members[applicant.ProfileID].Active && s.hasPolicyDevice(applicant) &&
		s.PolicyDevices[applicant.DeviceID].PublicKey == binding.SigningKey &&
		s.KeyRecipients[applicant.DeviceID] == (KeyRecipient{ProfileID: applicant.ProfileID, Kind: "device", PublicKey: binding.AgreementKey})
}

// ReadDeviceBindingApprover validates the active approving device against the
// proposal's exact predecessor, both at first use and during proof replay.
func ReadDeviceBindingApprover(ctx context.Context, query SessionQuery, approver Principal, draft PolicyDraft) (PolicyDevice, error) {
	if draft.Action != BindPolicyDevice {
		return PolicyDevice{}, InvalidAction
	}
	var state State
	var head PolicyProof
	var err error
	if draft.Revision == 0 {
		state, head, err = readCommittedPolicyState(ctx, query)
	} else {
		state, head, err = readPrecedingPolicyState(ctx, query, draft)
	}
	if err != nil {
		return PolicyDevice{}, err
	}
	if head.Digest != draft.PreviousDigest {
		return PolicyDevice{}, ErrPolicyConflict
	}
	if _, err := state.checkDeviceBinding(approver, draft.ResourceChange); err != nil {
		return PolicyDevice{}, err
	}
	device := state.PolicyDevices[approver.DeviceID]
	if !signingKeyMatches(approver.DeviceID, device.PublicKey) {
		return PolicyDevice{}, ErrPolicyConflict
	}
	return device, nil
}

func (s *Store) CommitDeviceBinding(ctx context.Context, resolve ResolveSession, intent PolicyDraft,
	verifyIntent VerifyPolicyDraft, sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	if intent.Action != BindPolicyDevice {
		return PolicyProof{}, InvalidAction
	}
	if _, err := deviceBindingApplicant(intent.ResourceChange); err != nil {
		return PolicyProof{}, err
	}
	if intent.ResourceChange.DeviceBinding.RebindAt != 0 {
		return PolicyProof{}, InvalidAction
	}
	return s.commitVerifiedMemberTransition(ctx, resolve, intent, intent.ResourceChange.DeviceBinding.ExpiresAt, verifyIntent, sign, verify, nil)
}

func queueDeviceBindingRotations(ctx context.Context, tx *sql.Tx, recipients map[string]map[string]bool, profile string, revision, now int64) error {
	for channel, readers := range recipients {
		fullHistory, visible := readers[profile]
		if !visible {
			continue
		}
		if err := enqueueRotation(ctx, tx, channel, LiveEpoch, revision, profile, now); err != nil {
			return err
		}
		if fullHistory {
			if err := enqueueRotation(ctx, tx, channel, ArchiveEpoch, revision, profile, now); err != nil {
				return err
			}
		}
	}
	return nil
}
