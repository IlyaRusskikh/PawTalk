package main

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"

	"pawtalk/server/internal/access"
)

type migrationRecipientProposal struct {
	ArchiveSHA256  string `json:"archiveSha256"`
	ReviewDigest   string `json:"reviewDigest"`
	OwnerProfileID string `json:"ownerProfileId"`
	DeviceID       string `json:"deviceId"`
	Nonce          string `json:"nonce"`
	PublicKey      string `json:"publicKey"`
	AgreementProof string `json:"agreementProof"`
	DeviceProof    string `json:"deviceProof"`
}

type migrationRecipientReceipt struct {
	ReviewDigest string `json:"reviewDigest"`
	DeviceID     string `json:"deviceId"`
	PublicKey    string `json:"publicKey"`
}

func migrationRecipientFrame(authority migrationAuthority, p migrationRecipientProposal, serverKey string) ([]byte, error) {
	return signatureFrame("pawtalk-migration-recipient-v1", authority.serverID, p.ArchiveSHA256, p.ReviewDigest, p.OwnerProfileID,
		p.DeviceID, p.Nonce, p.PublicKey, serverKey)
}

func (a *protectedMigrationAPI) enrollMigrationOwnerRecipient(w http.ResponseWriter, r *http.Request) {
	var p migrationRecipientProposal
	if _, err := decodeMemberJSON(w, r, 2048, &p); err != nil {
		memberFail(w, err)
		return
	}
	receipt, err := a.acceptMigrationOwnerRecipient(r.Context(), p)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, http.StatusOK, receipt)
}

func (a *protectedMigrationAPI) acceptMigrationOwnerRecipient(ctx context.Context, p migrationRecipientProposal) (migrationRecipientReceipt, error) {
	var result migrationRecipientReceipt
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_RECIPIENT")
	for _, id := range []string{p.ArchiveSHA256, p.ReviewDigest, p.OwnerProfileID, p.DeviceID, p.Nonce, p.PublicKey} {
		if !validHexID(id, 64) {
			return result, invalid
		}
	}
	agreement, err := decodeFixed(p.AgreementProof, sha256.Size)
	signature, signatureErr := decodeFixed(p.DeviceProof, ed25519.SignatureSize)
	rawKey, _ := hex.DecodeString(p.PublicKey)
	if err != nil || signatureErr != nil || littleEndianInteger(rawKey).Cmp(curve25519Field) >= 0 {
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
	authority, err := a.authorizeChallenge(ctx, tx, p.Nonce, p.DeviceID, signature, func(serverID string) ([]byte, error) {
		frame, err := migrationRecipientFrame(migrationAuthority{serverID: serverID}, p, publicMigrationAgreementKey(challenge.recovery))
		if err != nil {
			return nil, err
		}
		transcript = frame
		return signatureFrame("pawtalk-migration-recipient-device-v1", publicKeyID(frame), p.AgreementProof)
	})
	if err != nil {
		return result, err
	}
	if authority.archiveSHA256 != p.ArchiveSHA256 || authority.ownerID != p.OwnerProfileID {
		return result, invalid
	}
	if _, err := a.store.readValidImportApproval(ctx, tx, authority, p.ReviewDigest); err != nil {
		return result, err
	}
	recovery, err := readMigrationRecoveryEnrollment(ctx, tx, authority.ownerID)
	if err != nil {
		return result, err
	}
	if recovery == nil || recovery.AgreementKey == p.PublicKey || recovery.SigningKey == p.PublicKey {
		return result, invalid
	}
	remote, err := ecdh.X25519().NewPublicKey(rawKey)
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
	if !hmac.Equal(mac.Sum(nil), agreement) {
		return result, invalid
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_migration_owner_recipient (
		id INTEGER PRIMARY KEY CHECK(id=1),
		review_digest TEXT NOT NULL CHECK(length(review_digest)=64),
		device_id TEXT NOT NULL REFERENCES devices(device_id),
		public_key TEXT NOT NULL CHECK(length(public_key)=64),
		nonce TEXT NOT NULL CHECK(length(nonce)=64),
		server_key TEXT NOT NULL CHECK(length(server_key)=64),
		agreement_proof TEXT NOT NULL CHECK(length(agreement_proof)=43),
		device_proof BLOB NOT NULL CHECK(length(device_proof)=64)
	) STRICT`); err != nil {
		return result, err
	}
	inserted, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_owner_recipient
		(id,review_digest,device_id,public_key,nonce,server_key,agreement_proof,device_proof)
		VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, p.ReviewDigest, p.DeviceID, p.PublicKey, p.Nonce,
		publicMigrationAgreementKey(challenge.recovery), p.AgreementProof, signature)
	if err != nil {
		return result, err
	}
	count, err := inserted.RowsAffected()
	if err != nil {
		return result, err
	}
	if count == 1 {
		seed, err := randomHex(32)
		if err != nil {
			return result, err
		}
		if _, err := tx.ExecContext(ctx, `CREATE TABLE protected_migration_text_projection_seed (
			id INTEGER PRIMARY KEY CHECK(id=1), seed TEXT NOT NULL CHECK(length(seed)=64),
			projection_version INTEGER NOT NULL, preserve_channel_order INTEGER NOT NULL CHECK(preserve_channel_order=1),
			runtime_recovery INTEGER NOT NULL CHECK(runtime_recovery=1)
		) STRICT`); err != nil {
			return result, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_text_projection_seed
			(id,seed,projection_version,preserve_channel_order,runtime_recovery) VALUES(1,?,?,1,1)`,
			seed, access.ProfileRoleAuthorityProjectionVersion); err != nil {
			return result, err
		}
	}
	result, err = a.store.readValidMigrationOwnerRecipient(ctx, tx, authority)
	if err != nil {
		return migrationRecipientReceipt{}, err
	}
	if result != (migrationRecipientReceipt{p.ReviewDigest, p.DeviceID, p.PublicKey}) {
		return migrationRecipientReceipt{}, memberError(http.StatusConflict, "MIGRATION_RECIPIENT_ALREADY_ENROLLED")
	}
	if err := tx.Commit(); err != nil {
		return migrationRecipientReceipt{}, err
	}
	return result, nil
}

type migrationPolicyFormat struct {
	seed                 string
	projectionVersion    int
	preserveChannelOrder bool
	runtimeRecovery      bool
}

func readMigrationPolicyFormat(ctx context.Context, tx membershipIdentityQuery) (migrationPolicyFormat, error) {
	var format migrationPolicyFormat
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_text_projection_seed' AND type='table')`).Scan(&exists); err != nil || !exists {
		return format, err
	}
	var versioned bool
	if err := tx.QueryRowContext(ctx, `SELECT
		EXISTS(SELECT 1 FROM pragma_table_info('protected_migration_text_projection_seed') WHERE name='projection_version'),
		EXISTS(SELECT 1 FROM pragma_table_info('protected_migration_text_projection_seed') WHERE name='preserve_channel_order'),
		EXISTS(SELECT 1 FROM pragma_table_info('protected_migration_text_projection_seed') WHERE name='runtime_recovery')`).
		Scan(&versioned, &format.preserveChannelOrder, &format.runtimeRecovery); err != nil {
		return format, err
	}
	if !versioned {
		err := tx.QueryRowContext(ctx, "SELECT seed FROM protected_migration_text_projection_seed WHERE id=1").Scan(&format.seed)
		return format, err
	}
	err := tx.QueryRowContext(ctx, "SELECT seed,projection_version FROM protected_migration_text_projection_seed WHERE id=1").
		Scan(&format.seed, &format.projectionVersion)
	return format, err
}

func (s *membershipStore) readValidMigrationOwnerRecipient(ctx context.Context, tx membershipIdentityQuery, authority migrationAuthority) (migrationRecipientReceipt, error) {
	var result migrationRecipientReceipt
	p := migrationRecipientProposal{ArchiveSHA256: authority.archiveSHA256, OwnerProfileID: authority.ownerID}
	var serverKey string
	var signature []byte
	if err := tx.QueryRowContext(ctx, `SELECT review_digest,device_id,public_key,nonce,server_key,agreement_proof,device_proof
		FROM protected_migration_owner_recipient WHERE id=1`).Scan(&p.ReviewDigest, &p.DeviceID, &p.PublicKey, &p.Nonce,
		&serverKey, &p.AgreementProof, &signature); err != nil {
		return result, err
	}
	frame, err := migrationRecipientFrame(authority, p, serverKey)
	if err != nil {
		return result, err
	}
	signed, err := signatureFrame("pawtalk-migration-recipient-device-v1", publicKeyID(frame), p.AgreementProof)
	if err != nil {
		return result, err
	}
	if err := s.verifyMigrationDevice(ctx, tx, authority.ownerID, p.DeviceID, signed, signature); err != nil {
		return result, err
	}
	return migrationRecipientReceipt{p.ReviewDigest, p.DeviceID, p.PublicKey}, nil
}
