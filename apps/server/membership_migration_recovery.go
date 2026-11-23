package main

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"math/big"
	"net/http"
	"slices"
)

const migrationRecoverySchema = `CREATE TABLE protected_migration_owner_recovery (
	id INTEGER PRIMARY KEY CHECK(id=1),
	profile_id TEXT NOT NULL REFERENCES memberships(profile_id),
	recovery_id TEXT NOT NULL UNIQUE CHECK(length(recovery_id)=64),
	signing_key TEXT NOT NULL CHECK(length(signing_key)=64),
	agreement_key TEXT NOT NULL CHECK(length(agreement_key)=64)
) STRICT;
CREATE TABLE protected_migration_recovery_packages (
	channel_id TEXT PRIMARY KEY,
	key_id TEXT NOT NULL,
	recovery_id TEXT NOT NULL REFERENCES protected_migration_owner_recovery(recovery_id),
	device_id TEXT NOT NULL REFERENCES devices(device_id),
	ciphertext BLOB NOT NULL CHECK(length(ciphertext)=80),
	signature BLOB NOT NULL CHECK(length(signature)=64),
	confirmation BLOB NOT NULL CHECK(length(confirmation)=64),
	FOREIGN KEY(channel_id,key_id) REFERENCES protected_migration_channel_keys(channel_id,key_id)
) STRICT;`

type migrationRecoveryChallenge struct {
	migrationHistoryChallenge
	AgreementKey string `json:"agreementKey"`
}

type migrationRecoveryProposal struct {
	ArchiveSHA256  string `json:"archiveSha256"`
	OwnerProfileID string `json:"ownerProfileId"`
	DeviceID       string `json:"deviceId"`
	Nonce          string `json:"nonce"`
	SigningKey     string `json:"signingKey"`
	AgreementKey   string `json:"agreementKey"`
	RecoveryProof  string `json:"recoveryProof"`
	AgreementProof string `json:"agreementProof"`
	DeviceProof    string `json:"deviceProof"`
}

type migrationRecoveryEnrollment struct {
	RecoveryID   string `json:"recoveryId"`
	SigningKey   string `json:"signingKey"`
	AgreementKey string `json:"agreementKey"`
}

func publicMigrationAgreementKey(key *ecdh.PrivateKey) string {
	return hex.EncodeToString(key.PublicKey().Bytes())
}

func (a *protectedMigrationAPI) issueRecoveryChallenge(w http.ResponseWriter, r *http.Request) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		memberFail(w, err)
		return
	}
	a.issueMigrationChallenge(w, r, key)
}

func (a *protectedMigrationAPI) enrollOwnerRecovery(w http.ResponseWriter, r *http.Request) {
	var proposal migrationRecoveryProposal
	if _, err := decodeMemberJSON(w, r, 4096, &proposal); err != nil {
		memberFail(w, err)
		return
	}
	enrollment, err := a.acceptOwnerRecovery(r.Context(), proposal)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, http.StatusOK, enrollment)
}

func (a *protectedMigrationAPI) acceptOwnerRecovery(ctx context.Context, p migrationRecoveryProposal) (migrationRecoveryEnrollment, error) {
	var result migrationRecoveryEnrollment
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_RECOVERY")
	for _, field := range []string{p.ArchiveSHA256, p.OwnerProfileID, p.DeviceID, p.Nonce, p.SigningKey, p.AgreementKey} {
		if !validHexID(field, 64) {
			return result, invalid
		}
	}
	signingKey, _ := hex.DecodeString(p.SigningKey)
	agreementKey, _ := hex.DecodeString(p.AgreementKey)
	recoveryProof, recoveryErr := decodeFixed(p.RecoveryProof, ed25519.SignatureSize)
	agreementProof, agreementErr := decodeFixed(p.AgreementProof, sha256.Size)
	deviceProof, deviceErr := decodeFixed(p.DeviceProof, ed25519.SignatureSize)
	signingID := publicKeyID(signingKey)
	if recoveryErr != nil || agreementErr != nil || deviceErr != nil || signingID == p.DeviceID || signingID == p.OwnerProfileID ||
		p.SigningKey == p.AgreementKey || littleEndianInteger(agreementKey).Cmp(curve25519Field) >= 0 {
		return result, invalid
	}
	a.mu.Lock()
	challenge := a.challenges[p.Nonce]
	a.mu.Unlock()
	if challenge.recovery == nil {
		return result, memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
	}
	tx, err := a.importer.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var transcript []byte
	authority, err := a.authorizeChallenge(ctx, tx, p.Nonce, p.DeviceID, deviceProof, func(serverID string) ([]byte, error) {
		frame, err := signatureFrame("pawtalk-migration-owner-recovery-v1", serverID, p.ArchiveSHA256, p.OwnerProfileID,
			p.DeviceID, p.Nonce, p.SigningKey, p.AgreementKey, publicMigrationAgreementKey(challenge.recovery))
		if err != nil {
			return nil, err
		}
		transcript = frame
		return signatureFrame("pawtalk-migration-owner-recovery-device-v1", publicKeyID(frame), p.RecoveryProof, p.AgreementProof)
	})
	if err != nil {
		return result, err
	}
	if authority.archiveSHA256 != p.ArchiveSHA256 || authority.ownerID != p.OwnerProfileID ||
		!validRecoverySigningKey(signingKey, challenge.recovery) || !ed25519.Verify(signingKey, transcript, recoveryProof) {
		return result, invalid
	}
	remote, err := ecdh.X25519().NewPublicKey(agreementKey)
	if err != nil {
		return result, invalid
	}
	shared, err := challenge.recovery.ECDH(remote)
	if err != nil {
		return result, invalid
	}
	defer clear(shared)
	mac := hmac.New(sha256.New, shared)
	mac.Write(transcript)
	if !hmac.Equal(mac.Sum(nil), agreementProof) {
		return result, invalid
	}
	idFrame, err := signatureFrame("pawtalk-recovery-identity-v1", authority.serverID, authority.ownerID, p.SigningKey, p.AgreementKey)
	if err != nil {
		return result, err
	}
	recoveryID := publicKeyID(idFrame)
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_owner_recovery(id,profile_id,recovery_id,signing_key,agreement_key)
		VALUES(1,?,?,?,?) ON CONFLICT(id) DO NOTHING`, authority.ownerID, recoveryID, p.SigningKey, p.AgreementKey); err != nil {
		return result, err
	}
	stored, err := readMigrationRecoveryEnrollment(ctx, tx, authority.ownerID)
	if err != nil {
		return result, err
	}
	if stored == nil || stored.RecoveryID != recoveryID || stored.SigningKey != p.SigningKey || stored.AgreementKey != p.AgreementKey {
		return result, memberError(http.StatusConflict, "MIGRATION_RECOVERY_ALREADY_ENROLLED")
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return *stored, nil
}

var curve25519Field = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))

func littleEndianInteger(encoded []byte) *big.Int {
	bigEndian := slices.Clone(encoded)
	slices.Reverse(bigEndian)
	return new(big.Int).SetBytes(bigEndian)
}

// Ed25519.Verify checks the signature equation. Separately reject a low-order
// signing key using the public Edwards-to-Montgomery map in RFC 7748 §4.1
// and the standard X25519 low-order check.
func validRecoverySigningKey(encoded []byte, probe *ecdh.PrivateKey) bool {
	yBytes := slices.Clone(encoded)
	yBytes[31] &= 0x7f
	y := littleEndianInteger(yBytes)
	if y.Cmp(curve25519Field) >= 0 {
		return false
	}
	one := big.NewInt(1)
	inverse := new(big.Int).ModInverse(new(big.Int).Sub(one, y), curve25519Field)
	if inverse == nil {
		return false
	}
	u := new(big.Int).Mod(new(big.Int).Mul(new(big.Int).Add(one, y), inverse), curve25519Field)
	public := make([]byte, 32)
	u.FillBytes(public)
	slices.Reverse(public)
	key, err := ecdh.X25519().NewPublicKey(public)
	if err != nil {
		return false
	}
	check, err := probe.ECDH(key)
	clear(check)
	return err == nil
}

func readMigrationRecoveryEnrollment(ctx context.Context, tx *sql.Tx, owner string) (*migrationRecoveryEnrollment, error) {
	var result migrationRecoveryEnrollment
	err := tx.QueryRowContext(ctx, "SELECT recovery_id,signing_key,agreement_key FROM protected_migration_owner_recovery WHERE id=1 AND profile_id=?", owner).
		Scan(&result.RecoveryID, &result.SigningKey, &result.AgreementKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &result, nil
}
