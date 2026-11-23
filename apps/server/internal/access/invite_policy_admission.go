package access

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
)

type InvitePolicyAdmission struct {
	CutoverDigest string
	Claim         InviteRedeem
	Issuance      *InviteIssuance `json:",omitempty"`
	ServerKey     string          `json:",omitempty"`
}

type InvitePolicyUse struct {
	IssueSignature string
	Count          int64
}

type ConfirmInviteAdmission func(context.Context, *sql.Tx, InvitePolicyAdmission) error

func inviteClaimKey(value string) ([]byte, bool) {
	key, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return key, err == nil && len(key) == ed25519.PublicKeySize && base64.RawURLEncoding.EncodeToString(key) == value
}

func (s *State) admitInviteMember(actor Principal, change PolicyResourceChange, automatic bool) error {
	admission := change.Admission
	if admission == nil || change != (PolicyResourceChange{ID: change.ID, Admission: admission}) || !isDigest(admission.CutoverDigest) {
		return InvalidAction
	}
	if !automatic && (admission.ServerKey != "" || !s.inviteGrants(actor, 0).own) {
		return MissingGrant
	}
	profile, profileValid := inviteClaimKey(admission.Claim.ProfilePublicKey)
	device, deviceValid := inviteClaimKey(admission.Claim.DevicePublicKey)
	if !profileValid || !deviceValid || hexHash(profile) != change.ID || !validRecipientKey(admission.Claim.AgreementKey) ||
		!validInviteHex(admission.Claim.InviteID, 32) || !validInviteHex(admission.Claim.OperationID, 32) {
		return InvalidAction
	}
	profileID, deviceID := change.ID, hexHash(device)
	if automatic {
		if _, valid := inviteClaimKey(admission.ServerKey); !valid || admission.Issuance == nil ||
			actor != (Principal{ProfileID: profileID, DeviceID: deviceID}) {
			return InvalidAction
		}
		use := s.InvitationUses[admission.Claim.InviteID]
		issue := admission.Issuance
		if use.Count >= maxInviteUseLimit || (issue.MaxUses != 0 && use.Count >= issue.MaxUses) ||
			(use.Count > 0 && use.IssueSignature != issue.Signature) {
			return ErrInviteUnavailable
		}
		if s.InvitationUses == nil {
			s.InvitationUses = make(map[string]InvitePolicyUse)
		}
		s.InvitationUses[admission.Claim.InviteID] = InvitePolicyUse{IssueSignature: issue.Signature, Count: use.Count + 1}
	}
	existing := s.PolicyDevices[deviceID]
	if s.Members[profileID].Active || s.ProfileBindings[profileID] != "" || existing.ProfileID != "" && (!existing.Revoked || existing.ProfileID != profileID) {
		return ErrInviteConflict
	}
	if err := s.Policy.CheckAdmission(false); err != Allowed {
		return err
	}
	var acceptedAt int64
	if admission.Issuance != nil {
		acceptedAt = admission.Issuance.AcceptedAt
	}
	if removal := s.MemberRemovals[profileID]; removal.BannedAt(acceptedAt) {
		return MemberBanError{removal}
	}
	delete(s.MemberRemovals, profileID)
	// Readmission uses the current Everyone baseline. An old device or
	// recovery key must never receive another package through that baseline.
	s.retireMemberCredentials(profileID)
	s.clearDetachedPolicyDevices(profileID)
	s.Members[profileID] = Subject{ID: profileID, Active: true}
	s.PolicyDevices[deviceID] = PolicyDevice{ProfileID: profileID, PublicKey: hex.EncodeToString(device)}
	if err := s.changeRecipientKey(Principal{ProfileID: profileID, DeviceID: deviceID}, EnrollRecipientKey, admission.Claim.AgreementKey); err != nil {
		return err
	}
	s.refreshAdmissions()
	return nil
}

func (s *State) retireMemberCredentials(profileID string) {
	s.retireRecoveryIdentity(profileID)
	s.retirePolicyDevices(profileID)
}

func (s *State) retirePolicyDevices(profileID string) {
	for id, entry := range s.PolicyDevices {
		if entry.ProfileID == profileID {
			entry.Revoked = true
			s.PolicyDevices[id] = entry
		}
	}
	for id, entry := range s.KeyRecipients {
		if entry.ProfileID == profileID && entry.Kind == "device" {
			delete(s.KeyRecipients, id)
			if s.RetiredRecipientKeys == nil {
				s.RetiredRecipientKeys = make(map[string]bool)
			}
			s.RetiredRecipientKeys[entry.PublicKey] = true
		}
	}
}
