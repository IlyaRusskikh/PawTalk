package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"net/http"
	"path/filepath"
	"time"
)

type migrationHistoryCommitment struct {
	Digest  string `json:"digest"`
	Records int64  `json:"records"`
}

type verifiedMigrationImport struct {
	ServerID               string                           `json:"serverId"`
	ArchiveSHA256          string                           `json:"archiveSha256"`
	OwnerProfileID         string                           `json:"ownerProfileId"`
	History                migrationHistoryCommitment       `json:"history"`
	MessagePositionsDigest string                           `json:"messagePositionsDigest"`
	PolicyDigest           string                           `json:"policyDigest"`
	PolicyBlockers         []migrationPolicyBlocker         `json:"policyBlockers"`
	RecoveryArchive        migrationRecoveryArchiveCoverage `json:"recoveryArchive"`
	RecoveryArchiveDigest  string                           `json:"recoveryArchiveDigest,omitempty"`
	ReviewDigest           string                           `json:"reviewDigest,omitempty"`
	OwnerRecipient         *migrationRecipientReceipt       `json:"ownerRecipient,omitempty"`
	InitialPolicy          *migrationInitialPolicy          `json:"initialPolicy,omitempty"`
	PolicyAnchorDigest     string                           `json:"policyAnchorDigest,omitempty"`
	CurrentRecovery        *migrationEpochRecoveryCoverage  `json:"currentRecovery,omitempty"`
	HistoryLinks           *migrationHistoryLinkCoverage    `json:"historyLinks,omitempty"`
	CutoverDigest          string                           `json:"cutoverDigest,omitempty"`
	CutoverApproval        *migrationCutoverReceipt         `json:"cutoverApproval,omitempty"`
}

func verifyStandaloneMigrationImport(ctx context.Context, dir, archiveSHA256 string) (verifiedMigrationImport, error) {
	var report verifiedMigrationImport
	if !validHexID(archiveSHA256, 64) {
		return report, errors.New("usage: serve migration-verify <archive-sha256>")
	}
	db, err := openMembershipReadOnly(filepath.Join(dir, membershipDatabaseFile))
	if err != nil {
		return report, err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return report, err
	}
	defer tx.Rollback()
	store := &membershipStore{db: db, now: time.Now}
	report, err = store.readVerifiedMigrationImport(ctx, tx, dir, archiveSHA256)
	if err != nil {
		return report, err
	}
	return report, tx.Commit()
}

func (s *membershipStore) readVerifiedMigrationImport(ctx context.Context, tx *sql.Tx, dir, archiveSHA256 string) (verifiedMigrationImport, error) {
	var report verifiedMigrationImport
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		return report, err
	}
	if authority.archiveSHA256 != archiveSHA256 {
		return report, errors.New("local database does not match the expected migration checkpoint")
	}
	if _, err := readPinnedState(dir, authority.hostIdentitySHA256); err != nil {
		return report, err
	}
	var brokenLinks bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)").Scan(&brokenLinks); err != nil {
		return report, err
	}
	if brokenLinks {
		return report, memberError(http.StatusConflict, "MIGRATION_INVALID_RELATIONS")
	}
	history, err := s.verifyMigrationHistory(ctx, tx, authority)
	if err != nil {
		return report, err
	}
	positions, err := migrationMessagePositionsDigest(ctx, tx, authority)
	if err != nil {
		return report, err
	}
	policy, err := readMigrationPolicyDraft(ctx, tx, authority)
	if err != nil {
		return report, err
	}
	recoveryDigest, err := s.verifyMigrationRecoveryArchives(ctx, tx, authority, policy)
	if err != nil {
		return report, err
	}
	serialized, err := json.Marshal(policy)
	if err != nil {
		return report, err
	}
	report = verifiedMigrationImport{
		ServerID: authority.serverID, ArchiveSHA256: archiveSHA256, OwnerProfileID: authority.ownerID,
		History: history, MessagePositionsDigest: positions, PolicyDigest: publicKeyID(serialized), PolicyBlockers: policy.Blockers,
		RecoveryArchive: policy.OwnerRecoveryArchive, RecoveryArchiveDigest: recoveryDigest,
	}
	if len(report.PolicyBlockers) == 0 && report.RecoveryArchiveDigest != "" &&
		report.RecoveryArchive.ConfirmedPackages == report.RecoveryArchive.StagedKeys {
		report.ReviewDigest, err = migrationImportReviewDigest(report)
	}
	if err != nil {
		return verifiedMigrationImport{}, err
	}
	var recipientEnrolled bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_owner_recipient' AND type='table')`).Scan(&recipientEnrolled); err != nil {
		return verifiedMigrationImport{}, err
	}
	if recipientEnrolled {
		if _, err := s.readValidImportApproval(ctx, tx, authority, report.ReviewDigest); err != nil {
			return verifiedMigrationImport{}, err
		}
		recipient, err := s.readValidMigrationOwnerRecipient(ctx, tx, authority)
		if err != nil {
			return verifiedMigrationImport{}, err
		}
		if recipient.ReviewDigest != report.ReviewDigest {
			return verifiedMigrationImport{}, memberError(http.StatusConflict, "MIGRATION_IMPORT_REVIEW_CHANGED")
		}
		report.OwnerRecipient = &recipient
		format, err := readMigrationPolicyFormat(ctx, tx)
		if err != nil {
			return verifiedMigrationImport{}, err
		}
		initial, err := previewMigrationInitialPolicy(policy, authority.ownerID, recipient, format)
		if err != nil {
			return verifiedMigrationImport{}, err
		}
		report.InitialPolicy = &initial
	}
	var anchored bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_policy_anchor' AND type='table')`).Scan(&anchored); err != nil {
		return verifiedMigrationImport{}, err
	}
	if anchored {
		if report.InitialPolicy == nil {
			return verifiedMigrationImport{}, errors.New("missing initial migration policy")
		}
		proof, err := s.readMigrationPolicyAnchor(ctx, tx, authority, report)
		if err != nil {
			return verifiedMigrationImport{}, err
		}
		report.PolicyAnchorDigest = proof.Digest
		coverage, err := s.verifyMigrationEpochRecovery(ctx, tx, authority, report.PolicyAnchorDigest, proof.Principal, *policy.OwnerRecovery)
		if err != nil {
			return verifiedMigrationImport{}, err
		}
		report.CurrentRecovery = &coverage
		links, err := s.verifyMigrationHistoryLinks(ctx, tx, authority, report.PolicyAnchorDigest, proof.Principal)
		if err != nil {
			return verifiedMigrationImport{}, err
		}
		report.HistoryLinks = &links
	}
	if err := verifyMigrationCutoverInputs(ctx, tx, authority, &report); err != nil {
		return verifiedMigrationImport{}, err
	}
	report.CutoverApproval, err = s.readMigrationCutoverApproval(ctx, tx, report)
	if err != nil {
		return verifiedMigrationImport{}, err
	}
	return report, nil
}

// Verify staged bytes and provenance from the same transaction as coverage.
// This commitment covers ciphertext import for the pinned backup.
func (s *membershipStore) verifyMigrationHistory(ctx context.Context, tx *sql.Tx, authority migrationAuthority) (migrationHistoryCommitment, error) {
	var result migrationHistoryCommitment
	progress, err := readMigrationImportProgress(ctx, tx)
	if err != nil {
		return result, err
	}
	if !progress.Complete {
		return result, memberError(http.StatusConflict, "MIGRATION_IMPORT_INCOMPLETE")
	}
	header, err := signatureFrame("pawtalk-migration-history-commitment-v1", authority.serverID, authority.archiveSHA256, authority.ownerID)
	if err != nil {
		return result, err
	}
	commitment := sha256.New()
	commitment.Write(header)
	for _, kind := range []string{"messages", "attachments", "polls"} {
		if progress.Counts[kind].Imported == 0 {
			continue
		}
		count, err := s.verifyMigrationHistoryKind(ctx, tx, authority, kind, commitment)
		if err != nil {
			return result, err
		}
		if count != progress.Counts[kind].Source {
			return result, memberError(http.StatusConflict, "MIGRATION_STAGED_HISTORY_MISMATCH")
		}
		result.Records += count
	}
	result.Digest = hex.EncodeToString(commitment.Sum(nil))
	return result, nil
}

func (s *membershipStore) verifyMigrationHistoryKind(ctx context.Context, tx *sql.Tx, authority migrationAuthority, kind string, commitment hash.Hash) (int64, error) {
	relation := migrationHistoryRelations[kind]
	joinID := "s.source_id"
	if relation.numeric {
		joinID = "CAST(s.source_id AS INTEGER)"
	}
	rows, err := tx.QueryContext(ctx, `WITH frozen(id,metadata,nonce,ciphertext) AS (`+relation.query+`)
		SELECT s.source_id,s.channel_id,s.key_id,s.metadata,s.source_digest,s.nonce,s.ciphertext,s.ciphertext_sha256,
			s.migrator_device_id,s.signature,f.metadata,f.nonce,f.ciphertext,k.key_id
		FROM protected_migration_records s JOIN frozen f ON f.id=`+joinID+`
		JOIN protected_migration_channel_keys k ON k.channel_id=s.channel_id WHERE s.kind=?
		ORDER BY s.source_id`, kind)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var count int64
	invalid := memberError(http.StatusConflict, "MIGRATION_STAGED_HISTORY_MISMATCH")
	for rows.Next() {
		packet := migratedHistoryPacket{Kind: kind}
		var channel, cipherDigest, boundKey string
		var proof, stagedMetadata, metadata, nonce, ciphertext []byte
		if err := rows.Scan(&packet.ID, &channel, &packet.KeyID, &stagedMetadata, &packet.SourceDigest, &packet.Nonce, &packet.Ciphertext,
			&cipherDigest, &packet.MigratorDeviceID, &proof, &metadata, &nonce, &ciphertext, &boundKey); err != nil {
			return 0, err
		}
		source := sha256.New()
		source.Write(nonce)
		source.Write(ciphertext)
		fields, sourceChannel, legacyKey, err := migrationImportMetadata(metadata, stagedMetadata)
		if err != nil || sourceChannel != channel || packet.KeyID != boundKey || packet.KeyID == legacyKey ||
			!validHexID(channel, 32) || !validHexID(packet.KeyID, 64) || !validHexID(legacyKey, 64) ||
			len(nonce) != 12 || len(packet.Nonce) != 12 || len(ciphertext) != len(packet.Ciphertext) ||
			packet.SourceDigest != hex.EncodeToString(source.Sum(nil)) || cipherDigest != publicKeyID(packet.Ciphertext) {
			return 0, invalid
		}
		frame, err := migratedHistorySignatureFrame(authority, channel, packet, fields, cipherDigest)
		if err != nil {
			return 0, invalid
		}
		if err := s.verifyMigrationDevice(ctx, tx, authority.ownerID, packet.MigratorDeviceID, frame, proof); err != nil {
			return 0, err
		}
		// The verified frame binds identities and digests. Fixed-size hashes
		// delimit records without buffering the history.
		leaf := sha256.Sum256(frame)
		commitment.Write(leaf[:])
		count++
	}
	return count, rows.Err()
}

func (s *membershipStore) verifyMigrationRecoveryArchives(ctx context.Context, tx *sql.Tx, authority migrationAuthority, policy migrationPolicyDraft) (string, error) {
	recovery := policy.OwnerRecovery
	invalid := memberError(http.StatusConflict, "MIGRATION_STAGED_RECOVERY_MISMATCH")
	var total int64
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM protected_migration_recovery_packages").Scan(&total); err != nil {
		return "", err
	}
	if total != policy.OwnerRecoveryArchive.ConfirmedPackages || (recovery == nil && total != 0) {
		return "", invalid
	}
	if recovery == nil {
		return "", nil
	}
	id, err := signatureFrame("pawtalk-recovery-identity-v1", authority.serverID, authority.ownerID, recovery.SigningKey, recovery.AgreementKey)
	if err != nil || publicKeyID(id) != recovery.RecoveryID {
		return "", invalid
	}
	header, err := signatureFrame("pawtalk-migration-recovery-archive-commitment-v1", authority.serverID, authority.archiveSHA256, recovery.RecoveryID)
	if err != nil {
		return "", err
	}
	commitment := sha256.New()
	commitment.Write(header)
	rows, err := tx.QueryContext(ctx, `SELECT channel_id,key_id,device_id,ciphertext,signature,confirmation
		FROM protected_migration_recovery_packages WHERE recovery_id=? ORDER BY channel_id`, recovery.RecoveryID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var channel, key, device string
		var ciphertext, signature, confirmation []byte
		if err := rows.Scan(&channel, &key, &device, &ciphertext, &signature, &confirmation); err != nil {
			return "", err
		}
		if len(ciphertext) != 80 {
			return "", invalid
		}
		frame, err := s.verifyMigrationRecoveryArchiveProof(ctx, tx, authority, *recovery, channel, key, device,
			publicKeyID(ciphertext), signature, confirmation)
		if err != nil {
			return "", err
		}
		leaf := sha256.Sum256(frame)
		commitment.Write(leaf[:])
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return hex.EncodeToString(commitment.Sum(nil)), nil
}
