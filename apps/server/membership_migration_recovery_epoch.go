package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

type migrationEpochRecoveryPacket struct {
	RecoveryID          string `json:"recoveryId"`
	Ciphertext          string `json:"ciphertext"`
	Signature           string `json:"signature"`
	Confirmation        string `json:"confirmation"`
	RuntimeOpeningProof string `json:"runtimeOpeningProof,omitempty"`
}

type migrationEpochRecoveryReceipt struct {
	ChannelID            string `json:"channelId"`
	Purpose              string `json:"purpose"`
	KeyID                string `json:"keyId"`
	EpochDigest          string `json:"epochDigest"`
	RecoveryID           string `json:"recoveryId"`
	CiphertextSHA256     string `json:"ciphertextSha256"`
	RuntimePackageSHA256 string `json:"runtimePackageSha256,omitempty"`
}

type migrationEpochRecoveryCoverage struct {
	Expected  int64  `json:"expected"`
	Confirmed int64  `json:"confirmed"`
	Digest    string `json:"digest,omitempty"`
}

const migrationRecoveryEpochSchema = `CREATE TABLE IF NOT EXISTS protected_migration_recovery_epochs (
	channel_id TEXT NOT NULL,
	purpose TEXT NOT NULL CHECK(purpose IN ('live','archive')),
	generation INTEGER NOT NULL CHECK(generation=1),
	key_id TEXT NOT NULL CHECK(length(key_id)=64),
	epoch_digest TEXT NOT NULL CHECK(length(epoch_digest)=64),
	recovery_id TEXT NOT NULL REFERENCES protected_migration_owner_recovery(recovery_id),
	device_id TEXT NOT NULL REFERENCES devices(device_id),
	ciphertext BLOB NOT NULL CHECK(length(ciphertext)=80),
	signature BLOB NOT NULL CHECK(length(signature)=64),
	confirmation BLOB NOT NULL CHECK(length(confirmation)=64),
	PRIMARY KEY(channel_id,purpose),
	FOREIGN KEY(channel_id,purpose,generation) REFERENCES protected_epochs(channel_id,purpose,generation)
) STRICT`

func migrationEpochRecoveryFrame(authority migrationAuthority, anchor string, recovery migrationRecoveryEnrollment, receipt migrationEpochRecoveryReceipt, device string) ([]byte, error) {
	return signatureFrame("pawtalk-migration-recovery-epoch-package-v1", authority.serverID, authority.archiveSHA256,
		anchor, authority.ownerID, recovery.RecoveryID, recovery.AgreementKey, receipt.ChannelID,
		receipt.Purpose, "1", receipt.KeyID, receipt.EpochDigest, device)
}

func (a *protectedMigrationAPI) migrationEpochRecovery(ctx context.Context, resolve access.ResolveSession, action string, request migrationKeyRequest) (migrationEpochRecoveryReceipt, error) {
	var empty migrationEpochRecoveryReceipt
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_RECOVERY_PACKAGE")
	if !validHexID(request.ChannelID, 32) || !validHexID(request.KeyID, 64) || !validHexID(request.EpochDigest, 64) ||
		(request.Purpose != access.LiveEpoch && request.Purpose != access.ArchiveEpoch) ||
		(action == "backup") != (request.Backup != nil) {
		return empty, invalid
	}
	tx, err := a.importer.db.BeginTx(ctx, nil)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return empty, err
	}
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		return empty, err
	}
	recovery, err := readMigrationRecoveryEnrollment(ctx, tx, authority.ownerID)
	if err != nil {
		return empty, err
	}
	if recovery == nil {
		return empty, invalid
	}
	format, err := readMigrationPolicyFormat(ctx, tx)
	if err != nil {
		return empty, err
	}
	receipt, err := a.store.readMigrationRecoveryEpoch(ctx, tx, actor, request.ChannelID, request.Purpose)
	if err != nil {
		return empty, err
	}
	if receipt.KeyID != request.KeyID || receipt.EpochDigest != request.EpochDigest {
		return empty, memberError(http.StatusConflict, "MIGRATION_EPOCH_CONFLICT")
	}
	receipt.RecoveryID = recovery.RecoveryID
	if request.Backup != nil {
		p := request.Backup
		ciphertext, ciphertextErr := decodeFixed(p.Ciphertext, 80)
		signature, signatureErr := decodeFixed(p.Signature, ed25519.SignatureSize)
		confirmation, confirmationErr := decodeFixed(p.Confirmation, ed25519.SignatureSize)
		if p.RecoveryID != recovery.RecoveryID || ciphertextErr != nil || signatureErr != nil || confirmationErr != nil {
			return empty, invalid
		}
		var runtimeProof []byte
		var runtimeDigest string
		if format.runtimeRecovery {
			runtimeProof, err = decodeFixed(p.RuntimeOpeningProof, ed25519.SignatureSize)
			if err != nil {
				return empty, invalid
			}
			runtimeDigest, err = verifyMigrationRuntimeOpening(ctx, tx, authority, request.AnchorDigest, actor, receipt, runtimeProof)
			if err != nil {
				return empty, err
			}
		} else if p.RuntimeOpeningProof != "" {
			return empty, invalid
		}
		info, err := migrationEpochRecoveryFrame(authority, request.AnchorDigest, *recovery, receipt, actor.DeviceID)
		if err != nil {
			return empty, err
		}
		if _, err := a.store.verifyMigrationRecoveryPackageProof(ctx, tx, authority, *recovery, info,
			actor.DeviceID, publicKeyID(ciphertext), signature, confirmation); err != nil {
			return empty, err
		}
		if _, err := tx.ExecContext(ctx, migrationRecoveryEpochSchema); err != nil {
			return empty, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_recovery_epochs
			(channel_id,purpose,generation,key_id,epoch_digest,recovery_id,device_id,ciphertext,signature,confirmation)
			VALUES(?,?,1,?,?,?,?,?,?,?) ON CONFLICT(channel_id,purpose) DO NOTHING`, receipt.ChannelID, receipt.Purpose,
			receipt.KeyID, receipt.EpochDigest, receipt.RecoveryID, actor.DeviceID, ciphertext, signature, confirmation); err != nil {
			return empty, err
		}
		if format.runtimeRecovery {
			if _, err := tx.ExecContext(ctx, migrationRuntimeRecoverySchema); err != nil {
				return empty, err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_runtime_recovery
				(channel_id,purpose,package_digest,opening_proof) VALUES(?,?,?,?) ON CONFLICT(channel_id,purpose) DO NOTHING`,
				receipt.ChannelID, receipt.Purpose, runtimeDigest, runtimeProof); err != nil {
				return empty, err
			}
		}
	}
	receipt, err = a.store.readMigrationEpochRecoveryPackage(ctx, tx, authority, request.AnchorDigest, *recovery, receipt, actor, format.runtimeRecovery)
	if err != nil {
		return empty, err
	}
	if err := tx.Commit(); err != nil {
		return empty, err
	}
	return receipt, nil
}

func (s *membershipStore) readMigrationRecoveryEpoch(ctx context.Context, tx *sql.Tx, actor access.Principal, channel, purpose string) (migrationEpochRecoveryReceipt, error) {
	receipt := migrationEpochRecoveryReceipt{ChannelID: channel, Purpose: purpose}
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT key_id,digest,record FROM protected_epochs
		WHERE channel_id=? AND purpose=? AND generation=1`, channel, purpose).Scan(&receipt.KeyID, &receipt.EpochDigest, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return receipt, access.ErrEpochStale
	}
	if err != nil {
		return receipt, err
	}
	var proof access.EpochProof
	if err := json.Unmarshal(raw, &proof); err != nil {
		return receipt, err
	}
	record := proof.Record
	if proof.Principal != actor || record.ChannelID != channel || record.Purpose != purpose || record.Generation != 1 ||
		record.Revision != 1 || record.KeyID != receipt.KeyID || publicKeyID(record.Signature) != receipt.EpochDigest {
		return receipt, access.ErrEpochConflict
	}
	if err := verifyProtectedEpochSignature(ctx, tx, actor, record); err != nil {
		return receipt, err
	}
	return receipt, access.VerifyInitialEpochStorage(ctx, tx, proof)
}

func (s *membershipStore) readMigrationEpochRecoveryPackage(ctx context.Context, tx *sql.Tx, authority migrationAuthority,
	anchor string, recovery migrationRecoveryEnrollment, expected migrationEpochRecoveryReceipt, actor access.Principal,
	runtimeRecovery bool) (migrationEpochRecoveryReceipt, error) {
	pending := memberError(http.StatusConflict, "MIGRATION_EPOCH_RECOVERY_PENDING")
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_recovery_epochs' AND type='table')`).Scan(&exists); err != nil {
		return expected, err
	}
	if !exists {
		return expected, pending
	}
	var key, epoch, enrolled, signer string
	var ciphertext, signature, confirmation []byte
	err := tx.QueryRowContext(ctx, `SELECT key_id,epoch_digest,recovery_id,device_id,ciphertext,signature,confirmation
		FROM protected_migration_recovery_epochs WHERE channel_id=? AND purpose=? AND generation=1`, expected.ChannelID, expected.Purpose).
		Scan(&key, &epoch, &enrolled, &signer, &ciphertext, &signature, &confirmation)
	if errors.Is(err, sql.ErrNoRows) {
		return expected, pending
	}
	if err != nil {
		return expected, err
	}
	if key != expected.KeyID || epoch != expected.EpochDigest || enrolled != recovery.RecoveryID || signer != actor.DeviceID || len(ciphertext) != 80 {
		return expected, access.ErrEpochConflict
	}
	info, err := migrationEpochRecoveryFrame(authority, anchor, recovery, expected, actor.DeviceID)
	if err != nil {
		return expected, err
	}
	expected.CiphertextSHA256 = publicKeyID(ciphertext)
	if _, err := s.verifyMigrationRecoveryPackageProof(ctx, tx, authority, recovery, info, actor.DeviceID,
		expected.CiphertextSHA256, signature, confirmation); err != nil {
		return expected, err
	}
	if runtimeRecovery {
		expected.RuntimePackageSHA256, err = readMigrationRuntimeOpening(ctx, tx, authority, anchor, actor, expected)
	}
	return expected, err
}

func (s *membershipStore) verifyMigrationEpochRecovery(ctx context.Context, tx *sql.Tx, authority migrationAuthority,
	anchor string, actor access.Principal, recovery migrationRecoveryEnrollment) (migrationEpochRecoveryCoverage, error) {
	var coverage migrationEpochRecoveryCoverage
	format, err := readMigrationPolicyFormat(ctx, tx)
	if err != nil {
		return coverage, err
	}
	domain := "pawtalk-migration-recovery-epoch-coverage-v1"
	if format.runtimeRecovery {
		domain = "pawtalk-migration-recovery-epoch-coverage-v2"
	}
	frame, err := signatureFrame(domain, authority.serverID, authority.archiveSHA256, anchor, recovery.RecoveryID)
	if err != nil {
		return coverage, err
	}
	commitment := sha256.New()
	commitment.Write(frame)
	rows, err := tx.QueryContext(ctx, "SELECT channel_id FROM channels WHERE kind='text' ORDER BY channel_id")
	if err != nil {
		return coverage, err
	}
	defer rows.Close()
	for rows.Next() {
		var channel string
		if err := rows.Scan(&channel); err != nil {
			return coverage, err
		}
		for _, purpose := range []string{access.LiveEpoch, access.ArchiveEpoch} {
			coverage.Expected++
			epoch, err := s.readMigrationRecoveryEpoch(ctx, tx, actor, channel, purpose)
			if errors.Is(err, access.ErrEpochStale) {
				continue
			}
			if err != nil {
				return coverage, err
			}
			epoch.RecoveryID = recovery.RecoveryID
			receipt, err := s.readMigrationEpochRecoveryPackage(ctx, tx, authority, anchor, recovery, epoch, actor, format.runtimeRecovery)
			var pending *membershipError
			if errors.As(err, &pending) && pending.Code == "MIGRATION_EPOCH_RECOVERY_PENDING" {
				continue
			}
			if err != nil {
				return coverage, err
			}
			fields := []string{channel, purpose, epoch.KeyID, epoch.EpochDigest, receipt.CiphertextSHA256}
			if format.runtimeRecovery {
				fields = append(fields, receipt.RuntimePackageSHA256)
			}
			leaf, err := signatureFrame(fields...)
			if err != nil {
				return coverage, err
			}
			digest := sha256.Sum256(leaf)
			commitment.Write(digest[:])
			coverage.Confirmed++
		}
	}
	if err := rows.Err(); err != nil {
		return coverage, err
	}
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_recovery_epochs' AND type='table')`).Scan(&exists); err != nil {
		return coverage, err
	}
	if exists {
		var count int64
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM protected_migration_recovery_epochs").Scan(&count); err != nil {
			return coverage, err
		}
		if count != coverage.Confirmed {
			return coverage, access.ErrEpochConflict
		}
	}
	if coverage.Expected == coverage.Confirmed {
		coverage.Digest = hex.EncodeToString(commitment.Sum(nil))
	}
	return coverage, nil
}
