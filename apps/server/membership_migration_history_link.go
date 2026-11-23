package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

type migrationHistoryLink struct {
	Ciphertext string `json:"ciphertext"`
	Signature  string `json:"signature"`
}

type migrationHistoryLinkDelivery struct {
	ArchiveSHA256 string                `json:"archiveSha256"`
	AnchorDigest  string                `json:"anchorDigest"`
	ChannelID     string                `json:"channelId"`
	ArchiveKeyID  string                `json:"archiveKeyId"`
	EpochDigest   string                `json:"epochDigest"`
	ImportedKeyID string                `json:"importedKeyId"`
	DeviceID      string                `json:"deviceId"`
	Link          *migrationHistoryLink `json:"link,omitempty"`
}

type migrationHistoryLinkCoverage struct {
	Expected  int64  `json:"expected"`
	Confirmed int64  `json:"confirmed"`
	Digest    string `json:"digest,omitempty"`
}

const migrationHistoryLinkSchema = `CREATE TABLE IF NOT EXISTS protected_migration_history_links (
	channel_id TEXT PRIMARY KEY,
	imported_key_id TEXT NOT NULL,
	archive_key_id TEXT NOT NULL REFERENCES protected_epochs(key_id),
	epoch_digest TEXT NOT NULL CHECK(length(epoch_digest)=64),
	device_id TEXT NOT NULL REFERENCES devices(device_id),
	ciphertext BLOB NOT NULL CHECK(length(ciphertext)=60),
	signature BLOB NOT NULL CHECK(length(signature)=64),
	FOREIGN KEY(channel_id,imported_key_id) REFERENCES protected_migration_channel_keys(channel_id,key_id)
) STRICT`

func (a *protectedMigrationAPI) migrationHistoryLinkRequest(ctx context.Context, resolve access.ResolveSession,
	action string, request migrationKeyRequest) (migrationHistoryLinkDelivery, error) {
	var delivery migrationHistoryLinkDelivery
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_HISTORY_LINK")
	if !validHexID(request.ChannelID, 32) || !validHexID(request.KeyID, 64) || !validHexID(request.EpochDigest, 64) ||
		(action == "history-link") != (request.HistoryLink != nil) {
		return delivery, invalid
	}
	tx, err := a.importer.db.BeginTx(ctx, nil)
	if err != nil {
		return delivery, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return delivery, err
	}
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		return delivery, err
	}
	epoch, err := a.store.readMigrationRecoveryEpoch(ctx, tx, actor, request.ChannelID, access.ArchiveEpoch)
	if err != nil {
		return delivery, err
	}
	if epoch.KeyID != request.KeyID || epoch.EpochDigest != request.EpochDigest {
		return delivery, access.ErrEpochConflict
	}
	delivery = migrationHistoryLinkDelivery{ArchiveSHA256: authority.archiveSHA256, AnchorDigest: request.AnchorDigest,
		ChannelID: request.ChannelID, ArchiveKeyID: epoch.KeyID, EpochDigest: epoch.EpochDigest, DeviceID: actor.DeviceID}
	err = tx.QueryRowContext(ctx, "SELECT key_id FROM protected_migration_channel_keys WHERE channel_id=?", request.ChannelID).
		Scan(&delivery.ImportedKeyID)
	if errors.Is(err, sql.ErrNoRows) && request.HistoryLink == nil {
		return delivery, tx.Commit()
	}
	if err != nil {
		return delivery, err
	}
	if request.HistoryLink != nil {
		ciphertext, cipherErr := decodeFixed(request.HistoryLink.Ciphertext, 60)
		signature, signErr := decodeFixed(request.HistoryLink.Signature, ed25519.SignatureSize)
		if cipherErr != nil || signErr != nil {
			return delivery, invalid
		}
		if err := verifyMigrationHistoryLink(ctx, tx, authority.serverID, delivery, ciphertext, signature); err != nil {
			return delivery, err
		}
		if _, err := tx.ExecContext(ctx, migrationHistoryLinkSchema); err != nil {
			return delivery, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO protected_migration_history_links
			(channel_id,imported_key_id,archive_key_id,epoch_digest,device_id,ciphertext,signature)
			VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO NOTHING`, delivery.ChannelID, delivery.ImportedKeyID, delivery.ArchiveKeyID,
			delivery.EpochDigest, delivery.DeviceID, ciphertext, signature); err != nil {
			return delivery, err
		}
	}
	delivery.Link, err = readMigrationHistoryLink(ctx, tx, authority.serverID, delivery)
	if err != nil {
		return delivery, err
	}
	return delivery, tx.Commit()
}

func readMigrationHistoryLink(ctx context.Context, query membershipIdentityQuery, serverID string, delivery migrationHistoryLinkDelivery) (*migrationHistoryLink, error) {
	var exists bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_history_links' AND type='table')`).Scan(&exists); err != nil || !exists {
		return nil, err
	}
	var imported, archive, epoch, device string
	var ciphertext, signature []byte
	err := query.QueryRowContext(ctx, `SELECT imported_key_id,archive_key_id,epoch_digest,device_id,ciphertext,signature
		FROM protected_migration_history_links WHERE channel_id=?`, delivery.ChannelID).
		Scan(&imported, &archive, &epoch, &device, &ciphertext, &signature)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if imported != delivery.ImportedKeyID || archive != delivery.ArchiveKeyID || epoch != delivery.EpochDigest || device != delivery.DeviceID {
		return nil, access.ErrEpochConflict
	}
	if err := verifyMigrationHistoryLink(ctx, query, serverID, delivery, ciphertext, signature); err != nil {
		return nil, err
	}
	return &migrationHistoryLink{
		Ciphertext: base64.RawURLEncoding.EncodeToString(ciphertext), Signature: base64.RawURLEncoding.EncodeToString(signature),
	}, nil
}

func verifyMigrationHistoryLink(ctx context.Context, query membershipIdentityQuery, serverID string,
	delivery migrationHistoryLinkDelivery, ciphertext, signature []byte) error {
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_HISTORY_LINK")
	if len(ciphertext) != 60 || delivery.ArchiveKeyID == delivery.ImportedKeyID {
		return invalid
	}
	info, err := signatureFrame("pawtalk-migration-history-link-v1", serverID, delivery.ArchiveSHA256, delivery.AnchorDigest,
		delivery.ChannelID, delivery.ArchiveKeyID, delivery.EpochDigest, delivery.ImportedKeyID, delivery.DeviceID)
	if err != nil {
		return err
	}
	frame, err := signatureFrame("pawtalk-migration-history-link-signature-v1", publicKeyID(info), publicKeyID(ciphertext))
	if err != nil {
		return err
	}
	proofServerID, key, err := protectedSigner(ctx, query, delivery.DeviceID)
	if err != nil {
		return err
	}
	if proofServerID != serverID || !ed25519.Verify(key, frame, signature) {
		return invalid
	}
	return nil
}

func (s *membershipStore) verifyMigrationHistoryLinks(ctx context.Context, tx *sql.Tx, authority migrationAuthority,
	anchor string, actor access.Principal) (migrationHistoryLinkCoverage, error) {
	var coverage migrationHistoryLinkCoverage
	header, err := signatureFrame("pawtalk-migration-history-link-coverage-v1", authority.serverID, authority.archiveSHA256, anchor)
	if err != nil {
		return coverage, err
	}
	digest := sha256.New()
	digest.Write(header)
	rows, err := tx.QueryContext(ctx, "SELECT channel_id,key_id FROM protected_migration_channel_keys ORDER BY channel_id")
	if err != nil {
		return coverage, err
	}
	defer rows.Close()
	for rows.Next() {
		var channel, imported string
		if err := rows.Scan(&channel, &imported); err != nil {
			return coverage, err
		}
		coverage.Expected++
		epoch, err := s.readMigrationRecoveryEpoch(ctx, tx, actor, channel, access.ArchiveEpoch)
		if errors.Is(err, access.ErrEpochStale) {
			continue
		}
		if err != nil {
			return coverage, err
		}
		delivery := migrationHistoryLinkDelivery{ArchiveSHA256: authority.archiveSHA256, AnchorDigest: anchor,
			ChannelID: channel, ArchiveKeyID: epoch.KeyID, EpochDigest: epoch.EpochDigest, ImportedKeyID: imported, DeviceID: actor.DeviceID}
		link, err := readMigrationHistoryLink(ctx, tx, authority.serverID, delivery)
		if err != nil {
			return coverage, err
		}
		if link == nil {
			continue
		}
		proof, err := decodeFixed(link.Signature, ed25519.SignatureSize)
		if err != nil {
			return coverage, err
		}
		leaf := sha256.Sum256(proof)
		digest.Write(leaf[:])
		coverage.Confirmed++
	}
	if err := rows.Err(); err != nil {
		return coverage, err
	}
	if coverage.Confirmed == coverage.Expected {
		coverage.Digest = hex.EncodeToString(digest.Sum(nil))
	}
	return coverage, nil
}

func (s *membershipStore) dispatchMigrationHistoryLink(ctx context.Context, resolve access.ResolveSession, channel string,
	write func(migrationHistoryLinkDelivery) error) error {
	if !validHexID(channel, 32) {
		return memberError(http.StatusBadRequest, "INVALID_MIGRATION_HISTORY_LINK")
	}
	return access.NewStoreWithClock(s.db, s.now).DispatchFullArchive(ctx, resolve, channel, func(conn *sql.Conn) error {
		delivery := migrationHistoryLinkDelivery{ChannelID: channel}
		var serverID string
		var anchorRaw, epochRaw []byte
		err := conn.QueryRowContext(ctx, `SELECT s.server_id,m.backup_archive_sha256,a.proof_digest,k.key_id,e.key_id,
			e.digest,p.record,e.record FROM protected_migration_channel_keys k
			JOIN protected_epochs e ON e.channel_id=k.channel_id AND e.purpose='archive' AND e.generation=1
			CROSS JOIN protected_migration_source m CROSS JOIN server_state s CROSS JOIN protected_migration_policy_anchor a
			JOIN protected_policy_proofs p ON p.revision=1 AND p.digest=a.proof_digest
			WHERE k.channel_id=? AND m.id=1 AND s.id=1 AND a.id=1`, channel).
			Scan(&serverID, &delivery.ArchiveSHA256, &delivery.AnchorDigest, &delivery.ImportedKeyID,
				&delivery.ArchiveKeyID, &delivery.EpochDigest, &anchorRaw, &epochRaw)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(http.StatusNotFound, "MIGRATION_HISTORY_LINK_NOT_FOUND")
		}
		if err != nil {
			return err
		}
		var anchor access.PolicyProof
		var epoch access.EpochProof
		if json.Unmarshal(anchorRaw, &anchor) != nil || json.Unmarshal(epochRaw, &epoch) != nil ||
			anchor.Draft.Action != access.AnchorPolicy || anchor.Draft.Revision != 1 || publicKeyID(anchor.Draft.Signature) != delivery.AnchorDigest ||
			epoch.Record.Purpose != access.ArchiveEpoch || epoch.Record.Generation != 1 || epoch.Record.ChannelID != channel ||
			epoch.Record.KeyID != delivery.ArchiveKeyID || publicKeyID(epoch.Record.Signature) != delivery.EpochDigest ||
			epoch.Principal != anchor.Principal || epoch.Record.Revision != 1 || epoch.Record.PolicyDigest != anchor.Draft.ResultDigest {
			return access.ErrEpochConflict
		}
		if err := verifyProtectedPolicyDraft(ctx, conn, anchor.Principal, anchor.Draft); err != nil {
			return err
		}
		if err := verifyProtectedEpochSignature(ctx, conn, epoch.Principal, epoch.Record); err != nil {
			return err
		}
		delivery.DeviceID = anchor.Principal.DeviceID
		delivery.Link, err = readMigrationHistoryLink(ctx, conn, serverID, delivery)
		if err != nil {
			return err
		}
		if delivery.Link == nil {
			return memberError(http.StatusNotFound, "MIGRATION_HISTORY_LINK_NOT_FOUND")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return write(delivery)
	})
}
