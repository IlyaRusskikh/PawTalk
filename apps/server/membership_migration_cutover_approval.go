package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"time"

	"pawtalk/server/internal/access"
)

type migrationCutoverApproval struct {
	CutoverDigest  string                     `json:"cutoverDigest"`
	Signature      string                     `json:"signature"`
	ScopeAuthority *access.ScopeAuthorityLink `json:"scopeAuthority,omitempty"`
}

type migrationCutoverReceipt struct {
	CutoverDigest string `json:"cutoverDigest"`
	DeviceID      string `json:"deviceId"`
}

func migrationCutoverDigest(report verifiedMigrationImport) (string, error) {
	frame, err := signatureFrame("pawtalk-migration-cutover-v1", report.ServerID, report.ArchiveSHA256, report.OwnerProfileID,
		report.ReviewDigest, report.PolicyAnchorDigest, report.CurrentRecovery.Digest, report.HistoryLinks.Digest,
		report.OwnerRecipient.DeviceID, report.OwnerRecipient.PublicKey)
	if err != nil {
		return "", err
	}
	return publicKeyID(frame), nil
}

func verifyMigrationCutoverInputs(ctx context.Context, tx *sql.Tx, authority migrationAuthority, report *verifiedMigrationImport) error {
	if report.CurrentRecovery == nil || report.CurrentRecovery.Digest == "" || report.HistoryLinks == nil || report.HistoryLinks.Digest == "" {
		return nil
	}
	var pending bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM protected_rotation_tasks)").Scan(&pending); err != nil {
		return err
	}
	if pending {
		return nil
	}
	positions, err := digestMigrationMessagePositions(ctx, tx, authority,
		"SELECT channel_id,message_id,position FROM protected_migration_message_positions")
	if err != nil {
		return err
	}
	if positions != report.MessagePositionsDigest {
		return memberError(http.StatusConflict, "MIGRATION_INVALID_MESSAGE_POSITION")
	}
	report.CutoverDigest, err = migrationCutoverDigest(*report)
	return err
}

func approveStandaloneMigrationCutover(ctx context.Context, dir, archive string, input io.Reader) (migrationCutoverReceipt, error) {
	var receipt migrationCutoverReceipt
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_CUTOVER_APPROVAL")
	var approval migrationCutoverApproval
	if !validHexID(archive, 64) || decodeMigrationHostInput(input, &approval) != nil || !validHexID(approval.CutoverDigest, 64) {
		return receipt, invalid
	}
	signature, err := decodeFixed(approval.Signature, ed25519.SignatureSize)
	if err != nil {
		return receipt, invalid
	}
	db, err := openMigrationImportDatabase(filepath.Join(dir, membershipDatabaseFile))
	if err != nil {
		return receipt, err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback()
	store := &membershipStore{db: db, now: time.Now}
	report, err := store.readVerifiedMigrationImport(ctx, tx, dir, archive)
	if err != nil {
		return receipt, err
	}
	if report.CutoverDigest == "" {
		return receipt, memberError(http.StatusConflict, "MIGRATION_CUTOVER_NOT_READY")
	}
	if report.CutoverDigest != approval.CutoverDigest {
		return receipt, memberError(http.StatusConflict, "MIGRATION_CUTOVER_CHANGED")
	}
	receipt = migrationCutoverReceipt{CutoverDigest: approval.CutoverDigest, DeviceID: report.OwnerRecipient.DeviceID}
	if err := store.verifyMigrationCutoverApproval(ctx, tx, report, receipt, signature); err != nil {
		return migrationCutoverReceipt{}, err
	}
	if report.InitialPolicy == nil || report.InitialPolicy.RuntimeRecovery != (approval.ScopeAuthority != nil) {
		return migrationCutoverReceipt{}, invalid
	}
	if approval.ScopeAuthority != nil {
		if err := access.InstallGenesisScopeAuthority(ctx, tx, report.ServerID, receipt.CutoverDigest, *approval.ScopeAuthority); err != nil {
			if errors.Is(err, access.ErrScopeAuthority) {
				return migrationCutoverReceipt{}, invalid
			}
			return migrationCutoverReceipt{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_migration_cutover_approval (
		id INTEGER PRIMARY KEY CHECK(id=1),
		cutover_digest TEXT NOT NULL CHECK(length(cutover_digest)=64),
		device_id TEXT NOT NULL REFERENCES devices(device_id),
		signature BLOB NOT NULL CHECK(length(signature)=64)
	) STRICT`); err != nil {
		return migrationCutoverReceipt{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_cutover_approval(id,cutover_digest,device_id,signature)
		VALUES(1,?,?,?) ON CONFLICT(id) DO NOTHING`, receipt.CutoverDigest, receipt.DeviceID, signature); err != nil {
		return migrationCutoverReceipt{}, err
	}
	stored, err := store.readMigrationCutoverApproval(ctx, tx, report)
	if err != nil {
		return migrationCutoverReceipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return migrationCutoverReceipt{}, err
	}
	return *stored, nil
}

func (s *membershipStore) readMigrationCutoverApproval(ctx context.Context, tx *sql.Tx, report verifiedMigrationImport) (*migrationCutoverReceipt, error) {
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_cutover_approval' AND type='table')`).Scan(&exists); err != nil || !exists {
		return nil, err
	}
	var stored migrationCutoverReceipt
	var signature []byte
	if err := tx.QueryRowContext(ctx, "SELECT cutover_digest,device_id,signature FROM protected_migration_cutover_approval WHERE id=1").
		Scan(&stored.CutoverDigest, &stored.DeviceID, &signature); err != nil {
		return nil, err
	}
	if err := s.verifyMigrationCutoverApproval(ctx, tx, report, stored, signature); err != nil {
		return nil, err
	}
	if report.InitialPolicy == nil {
		return nil, memberError(http.StatusConflict, "MIGRATION_INITIAL_POLICY_CHANGED")
	}
	if report.InitialPolicy.RuntimeRecovery {
		_, state, err := access.ReadScopeAuthorityProofs(ctx, tx, report.ServerID, stored.CutoverDigest, 1)
		if err != nil {
			return nil, err
		}
		if state.Sequence != 1 {
			return nil, memberError(http.StatusConflict, "INVALID_MIGRATION_CUTOVER_APPROVAL")
		}
	}
	return &stored, nil
}

func (s *membershipStore) verifyMigrationCutoverApproval(ctx context.Context, tx *sql.Tx, report verifiedMigrationImport,
	receipt migrationCutoverReceipt, signature []byte) error {
	if report.CutoverDigest == "" || receipt.CutoverDigest != report.CutoverDigest || receipt.DeviceID != report.OwnerRecipient.DeviceID {
		return memberError(http.StatusConflict, "MIGRATION_CUTOVER_CHANGED")
	}
	frame, err := signatureFrame("pawtalk-migration-cutover-approval-v1", report.ServerID, report.ArchiveSHA256, report.OwnerProfileID,
		receipt.DeviceID, receipt.CutoverDigest)
	if err != nil {
		return err
	}
	return s.verifyMigrationDevice(ctx, tx, report.OwnerProfileID, receipt.DeviceID, frame, signature)
}
