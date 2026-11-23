package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"time"

	"pawtalk/server/internal/access"
)

const protectedDataSchemaVersion = 4

type protectedActivation struct {
	ServerID       string `json:"serverId"`
	ArchiveSHA256  string `json:"archiveSha256"`
	OwnerProfileID string `json:"ownerProfileId"`
	DeviceID       string `json:"deviceId"`
	RecipientKey   string `json:"recipientKey"`
	ReviewDigest   string `json:"reviewDigest"`
	AnchorDigest   string `json:"anchorDigest"`
	RecoveryDigest string `json:"recoveryDigest"`
	HistoryDigest  string `json:"historyDigest"`
	CutoverDigest  string `json:"cutoverDigest"`
}

func activateStandaloneProtectedRuntime(ctx context.Context, dir, archive string) (protectedActivation, error) {
	var activation protectedActivation
	if !validHexID(archive, 64) {
		return activation, errors.New("usage: serve migration-activate <archive-sha256>")
	}
	db, err := openMigrationImportDatabase(filepath.Join(dir, membershipDatabaseFile))
	if err != nil {
		return activation, err
	}
	defer db.Close()
	return activateProtectedRuntime(ctx, db, dir, archive)
}

func activateProtectedRuntime(ctx context.Context, db *sql.DB, dir, archive string) (protectedActivation, error) {
	var activation protectedActivation
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return activation, err
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return activation, err
	}
	if version == protectedDataSchemaVersion {
		activation, err := verifyProtectedActivation(ctx, tx, dir)
		if err != nil {
			return protectedActivation{}, err
		}
		if activation.ArchiveSHA256 != archive {
			return protectedActivation{}, memberError(http.StatusConflict, "MIGRATION_CHECKPOINT_CHANGED")
		}
		return activation, nil
	}
	store := &membershipStore{db: db, now: time.Now}
	report, err := store.readVerifiedMigrationImport(ctx, tx, dir, archive)
	if err != nil {
		return activation, err
	}
	if report.CutoverApproval == nil {
		return activation, memberError(http.StatusConflict, "MIGRATION_CUTOVER_APPROVAL_REQUIRED")
	}
	activation = protectedActivation{
		ServerID: report.ServerID, ArchiveSHA256: report.ArchiveSHA256, OwnerProfileID: report.OwnerProfileID,
		DeviceID: report.OwnerRecipient.DeviceID, RecipientKey: report.OwnerRecipient.PublicKey,
		ReviewDigest: report.ReviewDigest, AnchorDigest: report.PolicyAnchorDigest, RecoveryDigest: report.CurrentRecovery.Digest,
		HistoryDigest: report.HistoryLinks.Digest, CutoverDigest: report.CutoverDigest,
	}
	raw, err := json.Marshal(activation)
	if err != nil {
		return protectedActivation{}, err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE protected_runtime_activation (
		id INTEGER PRIMARY KEY CHECK(id=1),record BLOB NOT NULL
	) STRICT`); err != nil {
		return protectedActivation{}, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO protected_runtime_activation(id,record) VALUES(1,?)", raw); err != nil {
		return protectedActivation{}, err
	}
	if _, err := tx.ExecContext(ctx, protectedSessionSchema); err != nil {
		return protectedActivation{}, err
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", protectedDataSchemaVersion)); err != nil {
		return protectedActivation{}, err
	}
	if err := tx.Commit(); err != nil {
		return protectedActivation{}, err
	}
	return activation, nil
}

func verifyProtectedActivation(ctx context.Context, tx *sql.Tx, dir string) (protectedActivation, error) {
	var activation protectedActivation
	invalid := memberError(http.StatusServiceUnavailable, "INVALID_PROTECTED_ACTIVATION")
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return activation, err
	}
	if version != protectedDataSchemaVersion {
		return activation, invalid
	}
	authority, err := readFrozenMigrationAuthority(ctx, tx)
	if err != nil {
		return activation, err
	}
	if _, err := readPinnedState(dir, authority.hostIdentitySHA256); err != nil {
		return activation, err
	}
	var raw, signature []byte
	var digest, device string
	if err := tx.QueryRowContext(ctx, `SELECT a.record,c.cutover_digest,c.device_id,c.signature
		FROM protected_runtime_activation a CROSS JOIN protected_migration_cutover_approval c WHERE a.id=1 AND c.id=1`).
		Scan(&raw, &digest, &device, &signature); err != nil {
		return activation, err
	}
	if json.Unmarshal(raw, &activation) != nil || activation.ServerID != authority.serverID || activation.ArchiveSHA256 != authority.archiveSHA256 ||
		activation.OwnerProfileID != authority.ownerID || activation.DeviceID != device || activation.CutoverDigest != digest {
		return protectedActivation{}, invalid
	}
	for _, id := range []string{device, digest, activation.RecipientKey, activation.ReviewDigest, activation.AnchorDigest,
		activation.RecoveryDigest, activation.HistoryDigest} {
		if !validHexID(id, 64) {
			return protectedActivation{}, invalid
		}
	}
	report := verifiedMigrationImport{ServerID: authority.serverID, ArchiveSHA256: authority.archiveSHA256, OwnerProfileID: authority.ownerID,
		ReviewDigest: activation.ReviewDigest, PolicyAnchorDigest: activation.AnchorDigest,
		OwnerRecipient:  &migrationRecipientReceipt{DeviceID: device, PublicKey: activation.RecipientKey},
		CurrentRecovery: &migrationEpochRecoveryCoverage{Digest: activation.RecoveryDigest},
		HistoryLinks:    &migrationHistoryLinkCoverage{Digest: activation.HistoryDigest},
	}
	expected, err := migrationCutoverDigest(report)
	if err != nil || expected != digest {
		return protectedActivation{}, invalid
	}
	frame, err := signatureFrame("pawtalk-migration-cutover-approval-v1", authority.serverID, authority.archiveSHA256, authority.ownerID,
		device, digest)
	if err != nil {
		return protectedActivation{}, err
	}
	id, key, err := protectedSigner(ctx, tx, device)
	if err != nil || id != authority.serverID || !ed25519.Verify(key, frame, signature) {
		return protectedActivation{}, invalid
	}
	if err := access.VerifyMigrationGenesisScopeAuthority(ctx, tx, authority.serverID, digest); err != nil {
		return protectedActivation{}, err
	}
	if err := access.VerifyActivatedPolicyChain(ctx, tx, activation.AnchorDigest, access.Principal{ProfileID: authority.ownerID, DeviceID: device},
		verifyProtectedPolicyForActivation); err != nil {
		return protectedActivation{}, err
	}
	head, err := access.ReadPolicyHead(ctx, tx, nil)
	if err != nil {
		return protectedActivation{}, err
	}
	if _, _, err := access.ReadScopeAuthorityProofs(ctx, tx, activation.ServerID, activation.CutoverDigest, head.Draft.Revision); err != nil {
		return protectedActivation{}, err
	}
	return activation, nil
}

func verifyProtectedPolicyForActivation(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	if err := verifyProtectedPolicyDraft(ctx, query, actor, draft); err != nil {
		return err
	}
	if draft.Action != access.ConfirmPolicyRecovery {
		return nil
	}
	evidence, ok := query.(access.RecoveryEvidenceQuery)
	if !ok {
		return access.ErrPolicyConflict
	}
	serverID, _, err := protectedSigner(ctx, query, actor.DeviceID)
	if err != nil {
		return err
	}
	return access.VerifyHistoricalRecoveryConfirmationEvidence(ctx, evidence, actor, draft, serverID, verifyProtectedEpochSignature)
}
