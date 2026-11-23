package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"time"
)

type migrationImportApproval struct {
	ReviewDigest string `json:"reviewDigest"`
	DeviceID     string `json:"deviceId"`
	Signature    string `json:"signature"`
}

type migrationImportApprovalReceipt struct {
	ReviewDigest string `json:"reviewDigest"`
	DeviceID     string `json:"deviceId"`
}

func migrationImportReviewDigest(report verifiedMigrationImport) (string, error) {
	frame, err := signatureFrame("pawtalk-migration-import-review-v1", report.ServerID, report.ArchiveSHA256,
		report.OwnerProfileID, report.History.Digest, strconv.FormatInt(report.History.Records, 10),
		report.MessagePositionsDigest, report.PolicyDigest, report.RecoveryArchiveDigest,
		strconv.FormatInt(report.RecoveryArchive.StagedKeys, 10))
	if err != nil {
		return "", err
	}
	return publicKeyID(frame), nil
}

func readMigrationImportApproval(input io.Reader) (migrationImportApproval, error) {
	var approval migrationImportApproval
	if err := decodeMigrationHostInput(input, &approval); err != nil {
		return approval, err
	}
	if !validHexID(approval.DeviceID, 64) || !validHexID(approval.ReviewDigest, 64) {
		return approval, memberError(http.StatusBadRequest, "INVALID_MIGRATION_IMPORT_APPROVAL")
	}
	return approval, nil
}

func decodeMigrationHostInput(input io.Reader, output any) error {
	payload, err := io.ReadAll(io.LimitReader(input, 1025))
	if err != nil {
		return err
	}
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_IMPORT_APPROVAL")
	if len(payload) > 1024 {
		return invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return invalid
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return invalid
	}
	return nil
}

func approveStandaloneMigrationImport(ctx context.Context, dir, archiveSHA256 string, input io.Reader) (migrationImportApprovalReceipt, error) {
	var receipt migrationImportApprovalReceipt
	if !validHexID(archiveSHA256, 64) {
		return receipt, errors.New("usage: serve migration-approve-import <archive-sha256>")
	}
	approval, err := readMigrationImportApproval(input)
	if err != nil {
		return receipt, err
	}
	signature, err := decodeFixed(approval.Signature, ed25519.SignatureSize)
	if err != nil {
		return receipt, memberError(http.StatusBadRequest, "INVALID_MIGRATION_IMPORT_APPROVAL")
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
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		return receipt, err
	}
	if authority.archiveSHA256 != archiveSHA256 {
		return receipt, memberError(http.StatusConflict, "MIGRATION_CHECKPOINT_CHANGED")
	}
	frame, err := signatureFrame("pawtalk-migration-import-approval-v1", authority.serverID, authority.archiveSHA256,
		authority.ownerID, approval.DeviceID, approval.ReviewDigest)
	if err != nil {
		return receipt, err
	}
	store := &membershipStore{db: db, now: time.Now}
	if err := store.verifyMigrationDevice(ctx, tx, authority.ownerID, approval.DeviceID, frame, signature); err != nil {
		return receipt, err
	}
	report, err := store.readVerifiedMigrationImport(ctx, tx, dir, archiveSHA256)
	if err != nil {
		return receipt, err
	}
	if report.ReviewDigest == "" {
		return receipt, memberError(http.StatusConflict, "MIGRATION_IMPORT_REVIEW_UNAVAILABLE")
	}
	if report.ReviewDigest != approval.ReviewDigest {
		return receipt, memberError(http.StatusConflict, "MIGRATION_IMPORT_REVIEW_CHANGED")
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_migration_import_approval (
		id INTEGER PRIMARY KEY CHECK(id=1),
		review_digest TEXT NOT NULL CHECK(length(review_digest)=64),
		device_id TEXT NOT NULL REFERENCES devices(device_id),
		signature BLOB NOT NULL CHECK(length(signature)=64)
	) STRICT`); err != nil {
		return receipt, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_import_approval(id,review_digest,device_id,signature)
		VALUES(1,?,?,?) ON CONFLICT(id) DO NOTHING`, approval.ReviewDigest, approval.DeviceID, signature); err != nil {
		return receipt, err
	}
	receipt, err = store.readValidImportApproval(ctx, tx, authority, approval.ReviewDigest)
	if err != nil {
		return migrationImportApprovalReceipt{}, err
	}
	if err := indexApprovedMigrationHistory(ctx, tx, authority, report.MessagePositionsDigest); err != nil {
		return migrationImportApprovalReceipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return migrationImportApprovalReceipt{}, err
	}
	return receipt, nil
}

func (s *membershipStore) readValidImportApproval(ctx context.Context, tx *sql.Tx, authority migrationAuthority, digest string) (migrationImportApprovalReceipt, error) {
	var receipt migrationImportApprovalReceipt
	missing := memberError(http.StatusConflict, "MIGRATION_IMPORT_APPROVAL_REQUIRED")
	var exists bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='protected_migration_import_approval' AND type='table')").Scan(&exists); err != nil {
		return receipt, err
	}
	if !exists {
		return receipt, missing
	}
	var proof []byte
	err := tx.QueryRowContext(ctx, "SELECT review_digest,device_id,signature FROM protected_migration_import_approval WHERE id=1").
		Scan(&receipt.ReviewDigest, &receipt.DeviceID, &proof)
	if errors.Is(err, sql.ErrNoRows) {
		return receipt, missing
	}
	if err != nil {
		return receipt, err
	}
	if receipt.ReviewDigest != digest {
		return receipt, memberError(http.StatusConflict, "MIGRATION_IMPORT_REVIEW_CHANGED")
	}
	frame, err := signatureFrame("pawtalk-migration-import-approval-v1", authority.serverID, authority.archiveSHA256,
		authority.ownerID, receipt.DeviceID, receipt.ReviewDigest)
	if err != nil {
		return receipt, err
	}
	return receipt, s.verifyMigrationDevice(ctx, tx, authority.ownerID, receipt.DeviceID, frame, proof)
}
