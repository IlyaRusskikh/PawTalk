package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

const migrationRuntimeRecoverySchema = `CREATE TABLE IF NOT EXISTS protected_migration_runtime_recovery (
	channel_id TEXT NOT NULL,
	purpose TEXT NOT NULL CHECK(purpose IN ('live','archive')),
	package_digest TEXT NOT NULL CHECK(length(package_digest)=64),
	opening_proof BLOB NOT NULL CHECK(length(opening_proof)=64),
	PRIMARY KEY(channel_id,purpose),
	FOREIGN KEY(channel_id,purpose) REFERENCES protected_migration_recovery_epochs(channel_id,purpose)
) STRICT`

func verifyMigrationRuntimeOpening(ctx context.Context, tx *sql.Tx, authority migrationAuthority,
	anchor string, actor access.Principal, receipt migrationEpochRecoveryReceipt, openingProof []byte) (string, error) {
	delivery, err := access.ReadMigrationRecoveryEpochPackage(ctx, tx, actor, receipt.ChannelID, receipt.Purpose,
		receipt.KeyID, verifyProtectedEpochSignature)
	if err != nil {
		return "", err
	}
	if delivery.Package.RecipientID != receipt.RecoveryID || publicKeyID(delivery.Epoch.Record.Signature) != receipt.EpochDigest {
		return "", access.ErrEpochConflict
	}
	ciphertext := delivery.Package.Ciphertext
	digest := publicKeyID(ciphertext)
	frame, err := signatureFrame("pawtalk-migration-runtime-recovery-opening-v1", authority.serverID, authority.archiveSHA256,
		authority.ownerID, actor.DeviceID, receipt.RecoveryID, anchor, receipt.ChannelID, receipt.Purpose,
		"1", receipt.KeyID, receipt.EpochDigest, digest)
	if err != nil {
		return "", err
	}
	key := ed25519.PublicKey(ciphertext[len(ciphertext)-access.RecoveryEpochOpeningKeySize:])
	if !ed25519.Verify(key, frame, openingProof) {
		return "", memberError(http.StatusForbidden, "INVALID_MIGRATION_RUNTIME_RECOVERY_PROOF")
	}
	return digest, nil
}

func readMigrationRuntimeOpening(ctx context.Context, tx *sql.Tx, authority migrationAuthority,
	anchor string, actor access.Principal, receipt migrationEpochRecoveryReceipt) (string, error) {
	pending := memberError(http.StatusConflict, "MIGRATION_EPOCH_RECOVERY_PENDING")
	var exists bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_runtime_recovery' AND type='table')`).Scan(&exists)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", pending
	}
	var digest string
	var proof []byte
	err = tx.QueryRowContext(ctx, `SELECT package_digest,opening_proof FROM protected_migration_runtime_recovery
		WHERE channel_id=? AND purpose=?`, receipt.ChannelID, receipt.Purpose).Scan(&digest, &proof)
	if errors.Is(err, sql.ErrNoRows) {
		return "", pending
	}
	if err != nil {
		return "", err
	}
	expected, err := verifyMigrationRuntimeOpening(ctx, tx, authority, anchor, actor, receipt, proof)
	if err != nil {
		return "", err
	}
	if expected != digest {
		return "", access.ErrEpochConflict
	}
	return digest, nil
}
