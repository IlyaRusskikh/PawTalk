package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"reflect"
)

const migrationImportSchema = `
CREATE TABLE protected_migration_channel_keys (
	channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id),
	key_id TEXT NOT NULL UNIQUE,
	UNIQUE(channel_id,key_id)
) STRICT;
CREATE TABLE protected_migration_records (
	kind TEXT NOT NULL CHECK(kind IN ('messages','attachments','polls')),
	source_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	key_id TEXT NOT NULL,
	metadata TEXT NOT NULL,
	source_digest TEXT NOT NULL,
	nonce BLOB NOT NULL CHECK(length(nonce)=12),
	ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 17 AND 52428816),
	ciphertext_sha256 TEXT NOT NULL,
	migrator_device_id TEXT NOT NULL REFERENCES devices(device_id),
	signature BLOB NOT NULL CHECK(length(signature)=64),
	PRIMARY KEY(kind,source_id),
	FOREIGN KEY(channel_id,key_id) REFERENCES protected_migration_channel_keys(channel_id,key_id)
) STRICT;`

type migratedHistoryPacket struct {
	Version          int             `json:"version"`
	ArchiveSHA256    string          `json:"archiveSha256"`
	Kind             string          `json:"kind"`
	ID               string          `json:"id"`
	Generation       int             `json:"generation"`
	KeyID            string          `json:"keyId"`
	Metadata         json.RawMessage `json:"metadata"`
	SourceDigest     string          `json:"sourceDigest"`
	Nonce            []byte          `json:"nonce"`
	Ciphertext       []byte          `json:"ciphertext"`
	MigratorDeviceID string          `json:"migratorDeviceId"`
	Signature        string          `json:"signature"`
}

type migrationImportReceipt struct {
	Kind             string `json:"kind"`
	ID               string `json:"id"`
	CiphertextSHA256 string `json:"ciphertextSha256"`
}

func openMigrationImportDatabase(path string) (*sql.DB, error) {
	return openExistingMembershipDatabase(path, url.Values{
		"mode": {"rw"}, "_pragma": {"foreign_keys(1)", "busy_timeout(5000)"}, "_txlock": {"immediate"},
	})
}

func migrationCiphertextLimit(kind string) int {
	switch kind {
	case "messages", "polls":
		return 12304
	case "attachments":
		return 50*1024*1024 + 16
	default:
		return 0
	}
}

func (a *protectedMigrationAPI) importHistory(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	maximum := migrationCiphertextLimit(kind)
	nonce := r.Header.Get("X-PawTalk-Migration-Nonce")
	device := r.Header.Get("X-PawTalk-Migration-Device")
	bodyDigest := r.Header.Get("X-PawTalk-Migration-Body-SHA256")
	proof, err := decodeFixed(r.Header.Get("X-PawTalk-Migration-Signature"), ed25519.SignatureSize)
	if maximum == 0 || !validHexID(nonce, 64) || !validHexID(device, 64) || !validHexID(bodyDigest, 64) || err != nil {
		memberFail(w, memberError(http.StatusBadRequest, "INVALID_MIGRATION_PROOF"))
		return
	}
	ctx := r.Context()
	tx, err := a.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		memberFail(w, err)
		return
	}
	defer tx.Rollback()
	authority, err := a.authorizeChallenge(ctx, tx, nonce, device, proof, func(serverID string) ([]byte, error) {
		return signatureFrame("pawtalk-migration-import-request-v1", serverID, device, nonce, kind, bodyDigest)
	})
	if err != nil {
		memberFail(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		memberFail(w, err)
		return
	}
	select {
	case a.importSlot <- struct{}{}:
		defer func() { <-a.importSlot }()
	default:
		memberFail(w, memberError(http.StatusTooManyRequests, "MIGRATION_IMPORT_BUSY"))
		return
	}
	var packet migratedHistoryPacket
	limit := base64.StdEncoding.EncodedLen(maximum) + 8192
	raw, err := decodeMemberJSON(w, r, int64(limit), &packet)
	if err != nil {
		memberFail(w, err)
		return
	}
	if publicKeyID(raw) != bodyDigest || packet.Kind != kind || packet.MigratorDeviceID != device || packet.ArchiveSHA256 != authority.archiveSHA256 {
		memberFail(w, memberError(http.StatusBadRequest, "INVALID_MIGRATION_PACKET"))
		return
	}
	receipt, err := a.importer.stageMigratedHistoryRecord(ctx, packet)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, http.StatusOK, receipt)
}

// Import writes only to staging tables. The frozen API 2 rows and the archive
// remain available for verification and rollback until schema cutover.
func (s *membershipStore) stageMigratedHistoryRecord(ctx context.Context, packet migratedHistoryPacket) (migrationImportReceipt, error) {
	var receipt migrationImportReceipt
	invalidPacket := memberError(http.StatusBadRequest, "INVALID_MIGRATION_PACKET")
	maximum := migrationCiphertextLimit(packet.Kind)
	if maximum == 0 ||
		packet.Version != 1 || packet.Generation != 1 || packet.ID == "" || !validHexID(packet.ArchiveSHA256, 64) ||
		!validHexID(packet.KeyID, 64) || !validHexID(packet.SourceDigest, 64) || !validHexID(packet.MigratorDeviceID, 64) ||
		len(packet.Nonce) != 12 || len(packet.Ciphertext) < 17 || len(packet.Ciphertext) > maximum {
		return receipt, invalidPacket
	}
	proof, err := decodeFixed(packet.Signature, ed25519.SignatureSize)
	if err != nil {
		return receipt, invalidPacket
	}
	relation := migrationHistoryRelations[packet.Kind]
	position, err := migrationHistoryPosition(relation, packet.ID)
	if err != nil {
		return receipt, invalidPacket
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return receipt, err
	}
	defer tx.Rollback()
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		return receipt, err
	}
	if authority.archiveSHA256 != packet.ArchiveSHA256 {
		return receipt, memberError(http.StatusConflict, "MIGRATION_CHECKPOINT_CHANGED")
	}
	var source migrationHistoryRecord
	var metadata []byte
	err = tx.QueryRowContext(ctx, relation.query+" WHERE "+relation.key+"=?", position).Scan(&source.ID, &metadata, &source.Nonce, &source.Ciphertext)
	if errors.Is(err, sql.ErrNoRows) {
		return receipt, invalidPacket
	}
	if err != nil {
		return receipt, err
	}
	hash := sha256.New()
	hash.Write(source.Nonce)
	hash.Write(source.Ciphertext)
	if len(source.Nonce) != 12 || len(packet.Ciphertext) != len(source.Ciphertext) || packet.SourceDigest != hex.EncodeToString(hash.Sum(nil)) {
		return receipt, invalidPacket
	}
	fields, channelID, legacyKeyID, err := migrationImportMetadata(metadata, packet.Metadata)
	if err != nil || !validHexID(channelID, 32) || !validHexID(legacyKeyID, 64) || packet.KeyID == legacyKeyID {
		return receipt, invalidPacket
	}
	digest := publicKeyID(packet.Ciphertext)
	frame, err := migratedHistorySignatureFrame(authority, channelID, packet, fields, digest)
	if err != nil {
		return receipt, invalidPacket
	}
	if err := s.verifyMigrationDevice(ctx, tx, authority.ownerID, packet.MigratorDeviceID, frame, proof); err != nil {
		return receipt, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_channel_keys(channel_id,key_id) VALUES(?,?)
		ON CONFLICT DO NOTHING`, channelID, packet.KeyID); err != nil {
		return receipt, err
	}
	var boundKey string
	err = tx.QueryRowContext(ctx, "SELECT key_id FROM protected_migration_channel_keys WHERE channel_id=?", channelID).Scan(&boundKey)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && boundKey != packet.KeyID) {
		return receipt, memberError(http.StatusConflict, "MIGRATION_ARCHIVE_KEY_CONFLICT")
	}
	if err != nil {
		return receipt, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_records(kind,source_id,channel_id,key_id,metadata,source_digest,nonce,ciphertext,
		ciphertext_sha256,migrator_device_id,signature) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,source_id) DO NOTHING`,
		packet.Kind, packet.ID, channelID, boundKey, string(metadata), packet.SourceDigest, packet.Nonce, packet.Ciphertext,
		digest, packet.MigratorDeviceID, proof); err != nil {
		return receipt, err
	}
	receipt.Kind, receipt.ID = packet.Kind, packet.ID
	if err := tx.QueryRowContext(ctx, `SELECT ciphertext_sha256 FROM protected_migration_records WHERE kind=? AND source_id=?`,
		packet.Kind, packet.ID).Scan(&receipt.CiphertextSHA256); err != nil {
		return migrationImportReceipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return migrationImportReceipt{}, err
	}
	return receipt, nil
}

func migratedHistorySignatureFrame(authority migrationAuthority, channelID string, packet migratedHistoryPacket, fields []string, digest string) ([]byte, error) {
	frameFields := []string{"pawtalk-migrated-history-signature-v1", authority.serverID, authority.archiveSHA256, channelID,
		"1", packet.KeyID, packet.Kind, packet.ID, packet.SourceDigest}
	frameFields = append(frameFields, fields...)
	frameFields = append(frameFields, packet.MigratorDeviceID, base64.StdEncoding.EncodeToString(packet.Nonce), digest)
	return signatureFrame(frameFields...)
}

// The source SELECT constructs a fixed-order object. Compare incoming metadata
// by value, then use only source fields in the signature frame and staging row.
func migrationImportMetadata(source, submitted []byte) ([]string, string, string, error) {
	invalid := errors.New("migration metadata differs from source")
	if !json.Valid(submitted) {
		return nil, "", "", invalid
	}
	var received map[string]any
	reader := json.NewDecoder(bytes.NewReader(submitted))
	reader.UseNumber()
	if err := reader.Decode(&received); err != nil {
		return nil, "", "", invalid
	}
	reader = json.NewDecoder(bytes.NewReader(source))
	reader.UseNumber()
	if token, err := reader.Token(); err != nil || token != json.Delim('{') {
		return nil, "", "", invalid
	}
	var fields []string
	for reader.More() {
		field, keyErr := reader.Token()
		value, valueErr := reader.Token()
		key, ok := field.(string)
		receivedValue, exists := received[key]
		if keyErr != nil || valueErr != nil || !ok || !exists || !reflect.DeepEqual(value, receivedValue) {
			return nil, "", "", invalid
		}
		switch value := value.(type) {
		case string:
			fields = append(fields, value)
		case json.Number:
			fields = append(fields, value.String())
		case nil:
			fields = append(fields, "")
		default:
			return nil, "", "", invalid
		}
	}
	if len(fields) != len(received) {
		return nil, "", "", invalid
	}
	channelID, _ := received["channelId"].(string)
	legacyKeyID, _ := received["keyId"].(string)
	return fields, channelID, legacyKeyID, nil
}
