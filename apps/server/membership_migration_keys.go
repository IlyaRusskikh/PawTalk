package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

type migrationKeyRequest struct {
	ArchiveSHA256 string                        `json:"archiveSha256"`
	AnchorDigest  string                        `json:"anchorDigest"`
	ChannelID     string                        `json:"channelId,omitempty"`
	Purpose       string                        `json:"purpose,omitempty"`
	KeyID         string                        `json:"keyId,omitempty"`
	Record        access.EpochRecord            `json:"record,omitempty"`
	Packages      []access.EpochPackage         `json:"packages,omitempty"`
	Links         []access.ArchiveLink          `json:"links,omitempty"`
	Target        access.ArchiveTarget          `json:"target,omitempty"`
	After         int64                         `json:"after,omitempty"`
	EpochDigest   string                        `json:"epochDigest,omitempty"`
	Backup        *migrationEpochRecoveryPacket `json:"backup,omitempty"`
	HistoryLink   *migrationHistoryLink         `json:"historyLink,omitempty"`
}

func (a *protectedMigrationAPI) migrationKeys(w http.ResponseWriter, r *http.Request) {
	action := r.PathValue("action")
	switch action {
	case "claim", "commit", "target", "proof", "package", "recovery-package", "policy", "backup", "backup-status", "history-link", "history-link-status":
	default:
		http.NotFound(w, r)
		return
	}
	var request migrationKeyRequest
	raw, err := decodeMemberJSON(w, r, 65536, &request)
	if err != nil {
		memberFail(w, err)
		return
	}
	nonce := r.Header.Get("X-PawTalk-Migration-Nonce")
	device := r.Header.Get("X-PawTalk-Migration-Device")
	signature, err := decodeFixed(r.Header.Get("X-PawTalk-Migration-Signature"), ed25519.SignatureSize)
	if err != nil || !validHexID(nonce, 64) || !validHexID(device, 64) ||
		!validHexID(request.ArchiveSHA256, 64) || !validHexID(request.AnchorDigest, 64) {
		memberFail(w, memberError(http.StatusUnauthorized, "INVALID_MIGRATION_PROOF"))
		return
	}
	bodyDigest := publicKeyID(raw)
	resolve := func(ctx context.Context, db access.SessionQuery) (access.Principal, error) {
		authority, err := a.authorizeChallenge(ctx, db, nonce, device, signature, func(serverID string) ([]byte, error) {
			return signatureFrame("pawtalk-migration-keys-request-v1", serverID, action, nonce, device, bodyDigest)
		})
		if err != nil {
			return access.Principal{}, err
		}
		if authority.archiveSHA256 != request.ArchiveSHA256 {
			return access.Principal{}, memberError(http.StatusConflict, "MIGRATION_CHECKPOINT_CHANGED")
		}
		return a.store.authorizeMigrationKeyOwner(ctx, db, authority, device, request.AnchorDigest)
	}
	result, err := a.runMigrationKeyRequest(r.Context(), resolve, action, request)
	if err != nil {
		migrationKeyFail(w, err)
		return
	}
	respond(w, http.StatusOK, result)
}

func (s *membershipStore) authorizeMigrationKeyOwner(ctx context.Context, query access.SessionQuery, authority migrationAuthority,
	device, anchor string) (access.Principal, error) {
	var principal access.Principal
	var exists bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE
		name='protected_migration_policy_anchor' AND type='table')`).Scan(&exists); err != nil {
		return principal, err
	}
	unavailable := memberError(http.StatusConflict, "MIGRATION_INITIAL_POLICY_UNAVAILABLE")
	if !exists {
		return principal, unavailable
	}
	var digest, review string
	var binding []byte
	if err := query.QueryRowContext(ctx, `SELECT proof_digest,review_digest,import_binding FROM protected_migration_policy_anchor WHERE id=1`).
		Scan(&digest, &review, &binding); err != nil {
		return principal, err
	}
	recipient, err := s.readValidMigrationOwnerRecipient(ctx, query, authority)
	if err != nil {
		return principal, err
	}
	if anchor != digest || recipient.ReviewDigest != review || recipient.DeviceID != device {
		return principal, unavailable
	}
	actor := access.Principal{ProfileID: authority.ownerID, DeviceID: device}
	head, err := access.ReadPolicyHead(ctx, query, &actor)
	if err != nil {
		return principal, err
	}
	if head.Digest != anchor || head.Principal != actor || head.Draft.Action != access.AnchorPolicy {
		return principal, unavailable
	}
	if err := verifyProtectedPolicyDraft(ctx, query, actor, head.Draft); err != nil {
		return principal, err
	}
	frame, err := migrationPolicyBindingFrame(authority, verifiedMigrationImport{OwnerRecipient: &recipient, ReviewDigest: review}, head.Draft)
	if err != nil {
		return principal, err
	}
	if err := s.verifyMigrationDevice(ctx, query, authority.ownerID, device, frame, binding); err != nil {
		return principal, err
	}
	return actor, nil
}

func (a *protectedMigrationAPI) runMigrationKeyRequest(ctx context.Context, resolve access.ResolveSession, action string, request migrationKeyRequest) (any, error) {
	store := access.NewStoreWithClock(a.importer.db, a.store.now)
	switch action {
	case "history-link", "history-link-status":
		return a.migrationHistoryLinkRequest(ctx, resolve, action, request)
	case "backup", "backup-status":
		return a.migrationEpochRecovery(ctx, resolve, action, request)
	case "policy":
		if request.After != 0 && request.After != 1 {
			return nil, access.InvalidAction
		}
		page, err := store.PolicyProofPageForSession(ctx, resolve, request.After)
		// Migration policy is pinned before the cutover digest becomes a runtime trust input.
		page.GenesisScopeAuthority = nil
		return page, err
	case "commit":
		if request.Record.Generation != 1 || len(request.Packages) < 1 || len(request.Packages) > 2 || len(request.Links) > 1 ||
			!validHexID(request.Record.ChannelID, 32) {
			return nil, access.InvalidAction
		}
		err := store.CommitEpoch(ctx, resolve, verifyProtectedEpochSignature, request.Record, request.Packages, request.Links)
		return struct{}{}, err
	case "target":
		if request.Record.Generation != 1 || request.Target.Generation != 1 ||
			!validHexID(request.Record.ChannelID, 32) {
			return nil, access.InvalidAction
		}
		return store.LoadRotationTargetPackage(ctx, resolve, request.Record, request.Target)
	case "recovery-package":
		if !validHexID(request.ChannelID, 32) || !validHexID(request.KeyID, 64) {
			return nil, access.InvalidAction
		}
		tx, err := a.importer.db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		actor, err := resolve(ctx, tx)
		if err != nil {
			return nil, err
		}
		return access.ReadMigrationRecoveryEpochPackage(ctx, tx, actor, request.ChannelID, request.Purpose, request.KeyID, verifyProtectedEpochSignature)
	default:
		if !validHexID(request.ChannelID, 32) {
			return nil, access.InvalidAction
		}
		switch action {
		case "claim":
			return store.ClaimRotation(ctx, resolve, request.ChannelID, request.Purpose)
		case "proof":
			return store.LoadEpochProofPage(ctx, resolve, request.ChannelID, request.Purpose, 0, 1)
		case "package":
			if !validHexID(request.KeyID, 64) {
				return nil, access.InvalidAction
			}
			return store.LoadEpochPackage(ctx, resolve, request.ChannelID, request.KeyID, request.Purpose)
		}
		return nil, access.InvalidAction
	}
}

func migrationKeyFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, access.InvalidAction):
		err = memberError(http.StatusBadRequest, "INVALID_MIGRATION_KEYS_REQUEST")
	case errors.Is(err, access.ChannelRestricted), errors.Is(err, access.Inactive):
		err = memberError(http.StatusForbidden, "MIGRATION_KEYS_DENIED")
	case errors.Is(err, access.ErrEpochStale):
		err = memberError(http.StatusConflict, "MIGRATION_EPOCH_PENDING")
	case errors.Is(err, access.ErrEpochConflict), errors.Is(err, access.ErrPolicyConflict), errors.Is(err, access.ErrEpochRecipients):
		err = memberError(http.StatusConflict, "MIGRATION_EPOCH_CONFLICT")
	case errors.Is(err, access.ErrRotationLease), errors.Is(err, access.ErrRotationUnavailable):
		err = memberError(http.StatusConflict, "MIGRATION_ROTATION_UNAVAILABLE")
	}
	memberFail(w, err)
}
