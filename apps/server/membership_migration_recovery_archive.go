package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
)

type migrationRecoveryArchiveProposal struct {
	ArchiveSHA256 string `json:"archiveSha256"`
	RecoveryID    string `json:"recoveryId"`
	ChannelID     string `json:"channelId"`
	KeyID         string `json:"keyId"`
	DeviceID      string `json:"deviceId"`
	Nonce         string `json:"nonce"`
	Ciphertext    string `json:"ciphertext"`
	Signature     string `json:"signature"`
	Confirmation  string `json:"confirmation"`
	DeviceProof   string `json:"deviceProof"`
}

type migrationRecoveryArchiveReceipt struct {
	ChannelID        string `json:"channelId"`
	KeyID            string `json:"keyId"`
	RecoveryID       string `json:"recoveryId"`
	CiphertextSHA256 string `json:"ciphertextSha256"`
}

type migrationPendingRecoveryKey struct {
	ChannelID string `json:"channelId"`
	KeyID     string `json:"keyId"`
}

type migrationPendingRecoveryArchivePage struct {
	RecoveryID string                        `json:"recoveryId"`
	Keys       []migrationPendingRecoveryKey `json:"keys"`
	Next       string                        `json:"next,omitempty"`
}

func readMigrationPendingRecoveryArchive(ctx context.Context, tx *sql.Tx, authority migrationAuthority, cursor string, limit int) (migrationPendingRecoveryArchivePage, error) {
	page := migrationPendingRecoveryArchivePage{Keys: make([]migrationPendingRecoveryKey, 0, limit)}
	recovery, err := readMigrationRecoveryEnrollment(ctx, tx, authority.ownerID)
	if err != nil {
		return page, err
	}
	if recovery == nil {
		return page, memberError(http.StatusConflict, "MIGRATION_RECOVERY_NOT_ENROLLED")
	}
	page.RecoveryID = recovery.RecoveryID
	rows, err := tx.QueryContext(ctx, `SELECT k.channel_id,k.key_id FROM protected_migration_channel_keys k
		WHERE k.channel_id>? AND NOT EXISTS (
			SELECT 1 FROM protected_migration_recovery_packages p
			WHERE p.channel_id=k.channel_id AND p.key_id=k.key_id AND p.recovery_id=?
		) ORDER BY k.channel_id LIMIT ?`, cursor, recovery.RecoveryID, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		if len(page.Keys) == limit {
			page.Next = page.Keys[limit-1].ChannelID
			break
		}
		var key migrationPendingRecoveryKey
		if err := rows.Scan(&key.ChannelID, &key.KeyID); err != nil {
			return page, err
		}
		page.Keys = append(page.Keys, key)
	}
	return page, rows.Err()
}

func (a *protectedMigrationAPI) stageOwnerRecoveryArchive(w http.ResponseWriter, r *http.Request) {
	var p migrationRecoveryArchiveProposal
	if _, err := decodeMemberJSON(w, r, 3072, &p); err != nil {
		memberFail(w, err)
		return
	}
	receipt, err := a.acceptOwnerRecoveryArchive(r.Context(), p)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, http.StatusOK, receipt)
}

func (a *protectedMigrationAPI) acceptOwnerRecoveryArchive(ctx context.Context, p migrationRecoveryArchiveProposal) (migrationRecoveryArchiveReceipt, error) {
	var receipt migrationRecoveryArchiveReceipt
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_RECOVERY_PACKAGE")
	for _, id := range []string{p.ArchiveSHA256, p.RecoveryID, p.KeyID, p.DeviceID, p.Nonce} {
		if !validHexID(id, 64) {
			return receipt, invalid
		}
	}
	ciphertext, ciphertextErr := decodeFixed(p.Ciphertext, 80)
	signature, signatureErr := decodeFixed(p.Signature, ed25519.SignatureSize)
	confirmation, confirmationErr := decodeFixed(p.Confirmation, ed25519.SignatureSize)
	proof, proofErr := decodeFixed(p.DeviceProof, ed25519.SignatureSize)
	if !validHexID(p.ChannelID, 32) || ciphertextErr != nil || signatureErr != nil || confirmationErr != nil || proofErr != nil {
		return receipt, invalid
	}
	tx, err := a.importer.db.BeginTx(ctx, nil)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback()
	ciphertextDigest := publicKeyID(ciphertext)
	authority, err := a.authorizeChallenge(ctx, tx, p.Nonce, p.DeviceID, proof, func(serverID string) ([]byte, error) {
		return signatureFrame("pawtalk-migration-recovery-archive-request-v1", serverID, p.ArchiveSHA256, p.RecoveryID,
			p.ChannelID, p.KeyID, p.DeviceID, p.Nonce, ciphertextDigest, p.Signature, p.Confirmation)
	})
	if err != nil {
		return receipt, err
	}
	if authority.archiveSHA256 != p.ArchiveSHA256 {
		return receipt, invalid
	}
	enrollment, err := readMigrationRecoveryEnrollment(ctx, tx, authority.ownerID)
	if err != nil {
		return receipt, err
	}
	if enrollment == nil || enrollment.RecoveryID != p.RecoveryID {
		return receipt, invalid
	}
	if _, err := a.store.verifyMigrationRecoveryArchiveProof(ctx, tx, authority, *enrollment, p.ChannelID, p.KeyID,
		p.DeviceID, ciphertextDigest, signature, confirmation); err != nil {
		return receipt, err
	}
	var boundKey string
	err = tx.QueryRowContext(ctx, "SELECT key_id FROM protected_migration_channel_keys WHERE channel_id=?", p.ChannelID).Scan(&boundKey)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && boundKey != p.KeyID) {
		return receipt, memberError(http.StatusConflict, "MIGRATION_ARCHIVE_KEY_CONFLICT")
	}
	if err != nil {
		return receipt, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_recovery_packages
		(channel_id,key_id,recovery_id,device_id,ciphertext,signature,confirmation) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(channel_id) DO NOTHING`, p.ChannelID, p.KeyID, p.RecoveryID, p.DeviceID, ciphertext, signature, confirmation); err != nil {
		return receipt, err
	}
	var storedCiphertext []byte
	err = tx.QueryRowContext(ctx, `SELECT ciphertext FROM protected_migration_recovery_packages
		WHERE channel_id=? AND key_id=? AND recovery_id=?`, p.ChannelID, p.KeyID, p.RecoveryID).Scan(&storedCiphertext)
	if err != nil {
		return receipt, err
	}
	if err := tx.Commit(); err != nil {
		return receipt, err
	}
	return migrationRecoveryArchiveReceipt{p.ChannelID, p.KeyID, p.RecoveryID, publicKeyID(storedCiphertext)}, nil
}

func (s *membershipStore) verifyMigrationRecoveryArchiveProof(ctx context.Context, tx *sql.Tx, authority migrationAuthority,
	enrollment migrationRecoveryEnrollment, channelID, keyID, deviceID, ciphertextDigest string, signature, confirmation []byte) ([]byte, error) {
	info, err := signatureFrame("pawtalk-migration-recovery-archive-package-v1", authority.serverID, authority.archiveSHA256,
		authority.ownerID, enrollment.RecoveryID, enrollment.AgreementKey, channelID, keyID, deviceID)
	if err != nil {
		return nil, err
	}
	return s.verifyMigrationRecoveryPackageProof(ctx, tx, authority, enrollment, info, deviceID, ciphertextDigest, signature, confirmation)
}

func (s *membershipStore) verifyMigrationRecoveryPackageProof(ctx context.Context, tx membershipIdentityQuery, authority migrationAuthority,
	enrollment migrationRecoveryEnrollment, info []byte, deviceID, ciphertextDigest string, signature, confirmation []byte) ([]byte, error) {
	infoDigest := publicKeyID(info)
	signed, err := signatureFrame("pawtalk-migration-recovery-archive-signature-v1", infoDigest, ciphertextDigest)
	if err != nil {
		return nil, err
	}
	if err := s.verifyMigrationDevice(ctx, tx, authority.ownerID, deviceID, signed, signature); err != nil {
		return nil, err
	}
	confirmed, err := signatureFrame("pawtalk-migration-recovery-archive-confirmation-v1", infoDigest, ciphertextDigest)
	if err != nil {
		return nil, err
	}
	signingKey, err := hex.DecodeString(enrollment.SigningKey)
	if err != nil || len(signingKey) != ed25519.PublicKeySize || !ed25519.Verify(signingKey, confirmed, confirmation) {
		return nil, memberError(http.StatusBadRequest, "INVALID_MIGRATION_RECOVERY_PACKAGE")
	}
	return confirmed, nil
}
