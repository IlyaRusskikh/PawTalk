package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"time"

	"pawtalk/server/internal/access"
)

func protectedMessageFrame(serverID string, principal access.Principal, attempt access.MessageAttempt) ([]byte, error) {
	digest := sha256.Sum256(attempt.Ciphertext)
	if len(attempt.Attachments) != 0 || attempt.MentionDigest != "" {
		var checklist, poll string
		if attempt.Checklist != nil {
			checklist = attempt.Checklist.Digest()
		}
		if attempt.Poll != nil {
			poll = attempt.Poll.Digest()
		}
		fields := []string{"pawtalk-protected-message-v5", serverID, attempt.ChannelID, principal.ProfileID,
			principal.DeviceID, attempt.OperationID, attempt.KeyID, attempt.ReplyDigest, checklist, poll}
		if attempt.MentionDigest != "" {
			fields[0] = "pawtalk-protected-message-v6"
			fields = append(fields, attempt.MentionDigest)
		}
		for _, ref := range attempt.Attachments {
			fields = append(fields, ref.ID, ref.Kind)
		}
		return signatureFrame(append(fields, b64.EncodeToString(attempt.Nonce), hex.EncodeToString(digest[:]))...)
	}
	if attempt.Poll != nil {
		return signatureFrame("pawtalk-protected-message-v4", serverID, attempt.ChannelID, principal.ProfileID,
			principal.DeviceID, attempt.OperationID, attempt.KeyID, attempt.Poll.Digest(),
			b64.EncodeToString(attempt.Nonce), hex.EncodeToString(digest[:]))
	}
	if attempt.Checklist != nil {
		return signatureFrame("pawtalk-protected-message-v3", serverID, attempt.ChannelID, principal.ProfileID,
			principal.DeviceID, attempt.OperationID, attempt.KeyID, attempt.ReplyDigest, attempt.Checklist.Digest(),
			b64.EncodeToString(attempt.Nonce), hex.EncodeToString(digest[:]))
	}
	if attempt.ReplyDigest != "" {
		return signatureFrame("pawtalk-protected-message-v2", serverID, attempt.ChannelID, principal.ProfileID,
			principal.DeviceID, attempt.OperationID, attempt.KeyID, attempt.ReplyDigest,
			b64.EncodeToString(attempt.Nonce), hex.EncodeToString(digest[:]))
	}
	return signatureFrame("pawtalk-protected-message-v1", serverID, attempt.ChannelID,
		principal.ProfileID, principal.DeviceID, attempt.OperationID, attempt.KeyID,
		b64.EncodeToString(attempt.Nonce), hex.EncodeToString(digest[:]))
}

func protectedSigner(ctx context.Context, query access.SessionQuery, deviceID string) (string, ed25519.PublicKey, error) {
	var serverID string
	var key []byte
	err := query.QueryRowContext(ctx, `SELECT s.server_id, d.signing_public_key
	        FROM server_state s CROSS JOIN devices d WHERE s.id=1 AND d.device_id=?`, deviceID).
		Scan(&serverID, &key)
	if errors.Is(err, sql.ErrNoRows) {
		var encoded string
		err = query.QueryRowContext(ctx, `SELECT s.server_id,a.public_key FROM server_state s
			CROSS JOIN protected_invite_device_keys a WHERE s.id=1 AND a.device_id=?`, deviceID).Scan(&serverID, &encoded)
		if err == nil {
			key, err = decodeFixed(encoded, ed25519.PublicKeySize)
			if err != nil {
				return "", nil, memberError(403, "INVALID_DEVICE_KEY")
			}
		}
	}
	if errors.Is(err, sql.ErrNoRows) && validHexID(deviceID, 64) {
		var encoded string
		err = query.QueryRowContext(ctx, `SELECT s.server_id,json_extract(p.snapshot, '$.PolicyDevices."' || ? || '".PublicKey')
			FROM server_state s CROSS JOIN protected_policy p WHERE s.id=1 AND p.id=1
			AND json_type(p.snapshot, '$.PolicyDevices."' || ? || '".PublicKey')='text'`, deviceID, deviceID).Scan(&serverID, &encoded)
		if err == nil {
			key, err = hex.DecodeString(encoded)
			if err != nil {
				return "", nil, memberError(403, "INVALID_DEVICE_KEY")
			}
		}
	}
	if err == nil {
		digest := sha256.Sum256(key)
		if len(key) != ed25519.PublicKeySize || hex.EncodeToString(digest[:]) != deviceID {
			err = memberError(403, "INVALID_DEVICE_KEY")
		}
	}
	return serverID, key, err
}

// protectedSession reuses membership and device validation without consulting
// the legacy role table for protected channel operations.
func (s *membershipStore) protectedSession(token string) access.ResolveSession {
	return func(ctx context.Context, query access.SessionQuery) (access.Principal, error) {
		_, principal, err := s.protectedIdentity(ctx, query, token)
		return principal, err
	}
}

func (s *membershipStore) protectedIdentity(ctx context.Context, query access.SessionQuery, token string) (memberAccess, access.Principal, error) {
	if s.protectedBinding != "" {
		return s.runtimeIdentityForToken(ctx, query, token)
	}
	member, err := s.sessionIdentity(ctx, query, token)
	if err != nil {
		return memberAccess{}, access.Principal{}, err
	}
	actor, err := verifiedProtectedPrincipal(ctx, query, member, false)
	return member, actor, err
}

func verifiedProtectedPrincipal(ctx context.Context, query access.SessionQuery, member memberAccess, requireAnchor bool) (access.Principal, error) {
	principal := access.Principal{ProfileID: member.EffectiveProfileID, DeviceID: member.DeviceID}
	head, err := access.ReadPolicyHead(ctx, query, &principal)
	if err != nil {
		return access.Principal{}, err
	}
	if head.Digest == "" {
		if requireAnchor {
			return access.Principal{}, access.ErrPolicySignatureRequired
		}
		return principal, nil
	}
	return principal, verifyProtectedPolicyDraft(ctx, query, head.Principal, head.Draft)
}

func protectedPolicyFrame(serverID string, principal access.Principal, draft access.PolicyDraft) ([]byte, error) {
	roles, err := json.Marshal(draft.RoleUpdate)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(roles)
	fields := []string{"pawtalk-protected-policy-v1", serverID, principal.ProfileID, principal.DeviceID,
		draft.Action, draft.OperationID, strconv.FormatInt(draft.Revision, 10), draft.PreviousDigest, draft.ResultDigest,
		draft.PublicKey, hex.EncodeToString(digest[:])}
	if draft.TextProjectionRoot != "" {
		fields[0] = "pawtalk-protected-policy-v2"
		if access.HasTextRecipientProjection(draft.TextProjectionVersion) {
			fields[0] = "pawtalk-protected-policy-v" + strconv.Itoa(draft.TextProjectionVersion)
		}
		fields = append(fields, draft.TextProjectionRoot)
	}
	if change := draft.DeviceChange; change != nil {
		fields = append(fields, change.DeviceID, change.PublicKey, b64.EncodeToString(change.Consent))
	}
	if draft.ResourceChange != nil {
		raw, err := json.Marshal(draft.ResourceChange)
		if err != nil {
			return nil, err
		}
		hash := sha256.Sum256(raw)
		fields = append(fields, hex.EncodeToString(hash[:]))
	}
	return signatureFrame(fields...)
}

func protectedDeviceConsentFrame(serverID string, principal access.Principal, draft access.PolicyDraft, change access.PolicyDeviceChange) ([]byte, error) {
	return signatureFrame("pawtalk-protected-device-consent-v1", serverID, principal.ProfileID, principal.DeviceID,
		draft.OperationID, strconv.FormatInt(draft.Revision, 10), draft.PreviousDigest, draft.ResultDigest,
		change.DeviceID, change.PublicKey)
}

func verifyProtectedPolicyDraftSignature(ctx context.Context, query access.SessionQuery, principal access.Principal, draft access.PolicyDraft) error {
	if draft.Action == access.RedeemPolicyInvite || draft.Action == access.EnrollPolicyRecovery ||
		draft.Action == access.ConfirmPolicyRecovery || draft.Action == access.RecoverPolicyDevice ||
		draft.Action == access.TransferPolicyOwnership || draft.Action == access.BindPolicyDevice || draft.Action == access.MoveScopeDevice ||
		draft.Action == access.EditScopedChannelSettings || draft.Action == access.EditScopedChannelACLRoleRules || draft.Action == access.EditScopedChannelACLPersonal || draft.Action == access.EditScopedRoles ||
		draft.Action == access.LinkPolicyProfiles || draft.Action == access.UnlinkPolicyProfile || access.IsMemberDepartureAction(draft.Action) {
		return verifyProtectedServerPolicy(ctx, query, principal, draft)
	}
	serverID, key, err := protectedSigner(ctx, query, principal.DeviceID)
	if err != nil {
		return err
	}
	frame, err := protectedPolicyFrame(serverID, principal, draft)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, frame, draft.Signature) {
		return memberError(403, "INVALID_POLICY_SIGNATURE")
	}
	return nil
}

func verifyProtectedPolicyDraft(ctx context.Context, query access.SessionQuery, principal access.Principal, draft access.PolicyDraft) error {
	if err := verifyProtectedPolicyDraftSignature(ctx, query, principal, draft); err != nil {
		return err
	}
	if access.IsMemberDepartureAction(draft.Action) {
		return verifyProtectedDepartureIntent(ctx, query, principal, draft)
	}
	if draft.Action == access.EnrollPolicyRecovery {
		return verifyProtectedRecoveryEnrollment(ctx, query, principal, draft)
	}
	if draft.Action == access.ConfirmPolicyRecovery {
		return verifyProtectedRecoveryConfirmation(ctx, query, principal, draft)
	}
	if draft.Action == access.RecoverPolicyDevice {
		return verifyProtectedRecoveryDevice(ctx, query, principal, draft)
	}
	if draft.Action == access.TransferPolicyOwnership {
		return verifyProtectedOwnershipTransfer(ctx, query, principal, draft)
	}
	if draft.Action == access.BindPolicyDevice {
		return verifyProtectedDeviceBinding(ctx, query, principal, draft)
	}
	if draft.Action == access.LinkPolicyProfiles || draft.Action == access.UnlinkPolicyProfile {
		return verifyProtectedProfileLinking(ctx, query, principal, draft)
	}
	if draft.Action == access.MoveScopeDevice {
		return verifyProtectedScopeDeviceHandover(ctx, query, principal, draft)
	}
	switch draft.Action {
	case access.EditScopedChannelSettings, access.EditScopedChannelACLRoleRules, access.EditScopedChannelACLPersonal, access.EditScopedRoles:
		var serverID string
		if err := query.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
			return err
		}
		switch draft.Action {
		case access.EditScopedChannelSettings:
			return access.VerifyScopedChannelSettingsEdit(ctx, query, serverID, principal, draft)
		case access.EditScopedChannelACLRoleRules:
			return access.VerifyScopedChannelACLRoleRulesEdit(ctx, query, serverID, principal, draft)
		case access.EditScopedRoles:
			return access.VerifyScopedRoleEdit(ctx, query, serverID, principal, draft)
		default:
			return access.VerifyScopedChannelACLPersonalEdit(ctx, query, serverID, principal, draft)
		}
	}
	var serverID string
	if draft.Action == access.EnrollPolicyDevice || draft.Action == access.AdmitInviteMember || draft.Action == access.RedeemPolicyInvite {
		if err := query.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
			return err
		}
	}
	if draft.Action == access.EnrollPolicyDevice {
		change := draft.DeviceChange
		if change == nil {
			return memberError(403, "INVALID_DEVICE_CONSENT")
		}
		key, err := hex.DecodeString(change.PublicKey)
		if err != nil || len(key) != ed25519.PublicKeySize || publicKeyID(key) != change.DeviceID {
			return memberError(403, "INVALID_DEVICE_CONSENT")
		}
		frame, err := protectedDeviceConsentFrame(serverID, principal, draft, *change)
		if err != nil || !ed25519.Verify(key, frame, change.Consent) {
			return memberError(403, "INVALID_DEVICE_CONSENT")
		}
	}
	if draft.Action == access.AdmitInviteMember || draft.Action == access.RedeemPolicyInvite {
		if draft.ResourceChange == nil || draft.ResourceChange.Admission == nil {
			return access.InvalidAction
		}
		admission := draft.ResourceChange.Admission
		applicant, err := verifyInviteApplicantProof(serverID, admission.CutoverDigest, admission.Claim)
		if err != nil {
			return err
		}
		if applicant.ProfileID != draft.ResourceChange.ID ||
			draft.Action == access.RedeemPolicyInvite && (applicant.Principal != principal || admission.Issuance == nil) {
			return access.InvalidAction
		}
		if admission.Issuance != nil {
			return access.VerifyAdmissionIssuance(ctx, query, *admission, draft.Revision,
				verifyProtectedInvitationSignature, verifyProtectedPolicyDraftSignature)
		}
	}
	return nil
}

func (s *membershipStore) previewProtectedPolicy(ctx context.Context, token string, request access.PolicyDraft) (access.PolicyDraft, error) {
	return access.NewStoreWithClock(s.db, s.now).PreviewPolicy(ctx, s.protectedSession(token), request)
}

func (s *membershipStore) commitProtectedPolicy(ctx context.Context, token string, draft access.PolicyDraft) (access.PolicyProof, error) {
	return access.NewStoreWithClock(s.db, s.now).CommitPolicy(ctx, s.protectedSession(token), verifyProtectedPolicyDraft, draft)
}

func (s *membershipStore) appendProtectedMessage(ctx context.Context, token string, attempt access.MessageAttempt) (access.MessageReceipt, error) {
	return access.NewStoreWithClock(s.db, s.now).AppendMessage(ctx, s.protectedSession(token), verifyProtectedMessageAttempt, attempt, false)
}

func verifyProtectedMessageAttempt(ctx context.Context, query access.SessionQuery, principal access.Principal, now int64, attempt access.MessageAttempt) error {
	serverID, key, err := protectedSigner(ctx, query, principal.DeviceID)
	if err != nil {
		return err
	}
	frame, err := protectedMessageFrame(serverID, principal, attempt)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, frame, attempt.Signature) {
		return memberError(403, "INVALID_MESSAGE_SIGNATURE")
	}
	proof, err := access.ReadMessageEpoch(ctx, query, attempt.ChannelID, attempt.KeyID, now)
	if err != nil {
		return err
	}
	if err := verifyProtectedEpochSignature(ctx, query, proof.Principal, proof.Record); err != nil {
		return err
	}
	return access.VerifyEpochRecipient(ctx, query, principal, attempt.ChannelID, proof.Record.Generation)
}

func protectedEpochFrame(serverID string, principal access.Principal, record access.EpochRecord) ([]byte, error) {
	if !record.ValidArchiveWrapKey() || !record.ValidTransitionDigests() {
		return nil, access.InvalidAction
	}
	fields := []string{"pawtalk-protected-epoch-v1", serverID, record.ChannelID, record.Purpose,
		principal.ProfileID, principal.DeviceID, record.TaskID, record.LeaseID, strconv.FormatInt(record.Revision, 10),
		record.PolicyDigest, strconv.FormatUint(record.Generation, 10), record.PreviousDigest,
		record.KeyID, record.PackagesDigest, strconv.FormatUint(record.ArchiveThrough, 10), record.ArchiveLinksDigest}
	if record.ArchiveWrapKey != "" {
		fields[0] = "pawtalk-protected-epoch-v2"
		fields = append(fields, record.ArchiveWrapKey)
		if record.ArchiveTransitionDigest != "" {
			fields[0] = "pawtalk-protected-epoch-archive-transition-v1"
			fields = append(fields, record.ArchiveTransitionDigest)
		}
	} else if record.LiveTransitionDigest != "" {
		fields[0] = "pawtalk-protected-epoch-live-transition-v1"
		fields = append(fields, record.LiveTransitionDigest)
	}
	return signatureFrame(fields...)
}

func verifyProtectedEpochSignature(ctx context.Context, query access.SessionQuery, principal access.Principal, record access.EpochRecord) error {
	serverID, key, err := protectedSigner(ctx, query, principal.DeviceID)
	if err != nil {
		return err
	}
	frame, err := protectedEpochFrame(serverID, principal, record)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, frame, record.Signature) {
		return memberError(403, "INVALID_EPOCH_SIGNATURE")
	}
	return nil
}

func (s *membershipStore) claimProtectedRotation(ctx context.Context, token, channel, purpose string) (access.RotationTask, error) {
	return access.NewStoreWithClock(s.db, s.now).ClaimRotation(ctx, s.protectedSession(token), channel, purpose)
}

func (s *membershipStore) commitProtectedEpoch(ctx context.Context, token string, record access.EpochRecord, packages []access.EpochPackage, links ...access.ArchiveLink) error {
	return access.NewStoreWithClock(s.db, s.now).CommitEpoch(ctx, s.protectedSession(token), verifyProtectedEpochSignature, record, packages, links)
}

func (s *membershipStore) loadProtectedEpochPackage(ctx context.Context, token, channel, keyID, purpose string) (access.EpochPackageDelivery, error) {
	return access.NewStoreWithClock(s.db, s.now).LoadEpochPackage(ctx, s.protectedSession(token), channel, keyID, purpose)
}

func (s *membershipStore) loadProtectedEpochProofPage(ctx context.Context, token, channel, purpose string, after, through uint64) ([]access.EpochProof, error) {
	return access.NewStoreWithClock(s.db, s.now).LoadEpochProofPage(ctx, s.protectedSession(token), channel, purpose, after, through)
}

func (s *membershipStore) loadProtectedArchiveLinks(ctx context.Context, token, channel, keyID string) (access.ArchiveLinkDelivery, error) {
	return access.NewStoreWithClock(s.db, s.now).LoadArchiveLinks(ctx, s.protectedSession(token), channel, keyID)
}

func (s *membershipStore) loadProtectedRotationTarget(ctx context.Context, token string, record access.EpochRecord, target access.ArchiveTarget) (access.EpochPackageDelivery, error) {
	return access.NewStoreWithClock(s.db, s.now).LoadRotationTargetPackage(ctx, s.protectedSession(token), record, target)
}

func (s *membershipStore) dispatchProtectedBatch(ctx context.Context, conn net.Conn, token string, events []access.ScopedEvent) error {
	if len(events) > 64 {
		return io.ErrShortBuffer
	}
	var size int
	for _, event := range events {
		if len(event.Payload) > 32768-size {
			return io.ErrShortBuffer
		}
		size += len(event.Payload)
	}
	return access.NewStore(s.db).DispatchSession(ctx, s.protectedSession(token), events, func(result access.Projection) error {
		payload, err := json.Marshal(result)
		if err != nil {
			return err
		}
		return writeWSWithin(conn, 1, payload, 250*time.Millisecond)
	})
}
