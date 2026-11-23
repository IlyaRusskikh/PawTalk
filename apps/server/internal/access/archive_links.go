package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
)

const archiveBatchSize uint64 = 128
const ArchiveLinkSize = 60 // GCM nonce, wrapped 32-byte key and tag.

type ArchiveTarget struct {
	Purpose    string
	Generation uint64
	KeyID      string
}

type ArchiveLink struct {
	ArchiveTarget
	Ciphertext []byte
}

type ArchiveLinkDelivery struct {
	Epoch EpochProof
	Links []ArchiveLink
}

func (s *Store) LoadArchiveLinks(ctx context.Context, resolve ResolveSession, channel, keyID string) (ArchiveLinkDelivery, error) {
	var result ArchiveLinkDelivery
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return result, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return result, err
	}
	return loadArchiveLinks(ctx, tx, state, actor, channel, keyID)
}

func (s *Store) DispatchArchiveLinks(ctx context.Context, resolve ResolveSession, channel, keyID string,
	verify VerifyEpochRecord, scoped *TextChannelPolicyProofCache, deliver func(ArchiveLinkDelivery) error) error {
	if verify == nil {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		result, err := loadArchiveLinks(ctx, conn, state, actor, channel, keyID)
		if err != nil {
			return err
		}
		if err := verify(ctx, conn, result.Epoch.Principal, result.Epoch.Record); err != nil {
			return err
		}
		if scoped != nil {
			var policies historicalEpochSigningPolicies
			result.Epoch.SigningPolicy, err = policies.disclose(ctx, conn, scoped, result.Epoch)
			if err != nil {
				return err
			}
			if err := setInviteAdmissionSigningProof(ctx, conn, &policies, &result.Epoch, &scoped.history); err != nil {
				return err
			}
			var transitions archiveTransitionProofs
			if err := transitions.disclose(ctx, conn, state, actor, &result.Epoch, verify); err != nil {
				return err
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(result)
	})
}

func loadArchiveLinks(ctx context.Context, query interface {
	SessionQuery
	epochDeliveryQuery
}, state State, actor Principal, channel, keyID string) (ArchiveLinkDelivery, error) {
	var result ArchiveLinkDelivery
	if !state.canUseDevice(actor) || !state.canLoadEpoch(actor, channel, ArchiveEpoch) {
		return result, ChannelRestricted
	}
	current := state.ArchiveHeads[channel]
	device := state.KeyRecipients[actor.DeviceID]
	if current == 0 {
		return result, ErrEpochStale
	}
	var enrolled bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_epoch_packages WHERE channel_id=? AND
	    purpose='archive' AND generation=? AND recipient_id=? AND recipient_key=?)`,
		channel, current, actor.DeviceID, device.PublicKey).Scan(&enrolled); err != nil {
		return result, err
	}
	if !enrolled {
		return result, ErrEpochRecipients
	}
	epoch, err := readEpoch(ctx, query, channel, ArchiveEpoch, keyID)
	if err != nil {
		return ArchiveLinkDelivery{}, err
	}
	result.Epoch = epoch
	if epoch.Record.Generation > current {
		return ArchiveLinkDelivery{}, ErrEpochStale
	}
	result.Links, err = readArchiveLinks(ctx, query, channel, epoch.Record.Generation)
	if err != nil {
		return ArchiveLinkDelivery{}, err
	}
	digest, err := ArchiveLinksDigest(result.Links)
	if err != nil || digest != result.Epoch.Record.ArchiveLinksDigest {
		return ArchiveLinkDelivery{}, ErrEpochConflict
	}
	return result, nil
}

func readArchiveLinks(ctx context.Context, tx epochDeliveryQuery, channel string, generation uint64) ([]ArchiveLink, error) {
	rows, err := tx.QueryContext(ctx, `SELECT purpose,target_generation,target_key_id,ciphertext FROM protected_archive_links
	    WHERE channel_id=? AND archive_generation=? ORDER BY purpose,target_generation LIMIT 130`, channel, generation)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var links []ArchiveLink
	for rows.Next() {
		var link ArchiveLink
		if err := rows.Scan(&link.Purpose, &link.Generation, &link.KeyID, &link.Ciphertext); err != nil {
			return nil, err
		}
		links = append(links, link)
	}
	return links, rows.Err()
}

func previousArchiveCoverage(ctx context.Context, tx SessionQuery, channel string, generation uint64) (uint64, error) {
	if generation == 1 {
		return 0, nil
	}
	var key string
	if err := tx.QueryRowContext(ctx, "SELECT key_id FROM protected_epochs WHERE channel_id=? AND purpose='archive' AND generation=?",
		channel, generation-1).Scan(&key); err != nil {
		return 0, err
	}
	proof, err := readEpoch(ctx, tx, channel, ArchiveEpoch, key)
	if err != nil {
		return 0, err
	}
	return proof.Record.ArchiveThrough, nil
}

func archiveTargets(ctx context.Context, tx SessionQuery, channel string, archiveGeneration, covered, through uint64) ([]ArchiveTarget, error) {
	targets := make([]ArchiveTarget, 0, through-covered+1)
	add := func(purpose string, generation uint64) error {
		target := ArchiveTarget{Purpose: purpose, Generation: generation}
		if err := tx.QueryRowContext(ctx, "SELECT key_id FROM protected_epochs WHERE channel_id=? AND purpose=? AND generation=?",
			channel, purpose, generation).Scan(&target.KeyID); err != nil {
			return err
		}
		targets = append(targets, target)
		return nil
	}
	if archiveGeneration > 1 {
		if err := add(ArchiveEpoch, archiveGeneration-1); err != nil {
			return nil, err
		}
	}
	for generation := covered + 1; generation <= through; generation++ {
		if err := add(LiveEpoch, generation); err != nil {
			return nil, err
		}
	}
	return targets, nil
}

func ArchiveLinksDigest(links []ArchiveLink) (string, error) {
	if len(links) == 0 || len(links) > int(archiveBatchSize)+1 {
		return "", ErrEpochConflict
	}
	for _, link := range links {
		if len(link.Ciphertext) != ArchiveLinkSize || !isDigest(link.KeyID) ||
			link.Generation == 0 || (link.Purpose != ArchiveEpoch && link.Purpose != LiveEpoch) {
			return "", ErrEpochConflict
		}
	}
	raw, err := json.Marshal(links)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:]), nil
}

func checkArchiveLinks(ctx context.Context, tx *sql.Tx, state State, record EpochRecord, links []ArchiveLink) error {
	if record.Purpose == LiveEpoch {
		if record.ArchiveThrough != 0 || record.ArchiveLinksDigest != "" || len(links) != 0 {
			return InvalidAction
		}
		return nil
	}
	covered, err := previousArchiveCoverage(ctx, tx, record.ChannelID, record.Generation)
	if err != nil {
		return err
	}
	if record.ArchiveThrough == 0 || record.ArchiveThrough < covered || record.ArchiveThrough-covered > archiveBatchSize ||
		record.ArchiveThrough > state.currentGeneration(record.ChannelID, LiveEpoch) {
		return ErrEpochConflict
	}
	targets, err := archiveTargets(ctx, tx, record.ChannelID, record.Generation, covered, record.ArchiveThrough)
	if err != nil {
		return err
	}
	digest, err := ArchiveLinksDigest(links)
	if err != nil || digest != record.ArchiveLinksDigest || len(links) != len(targets) {
		return ErrEpochConflict
	}
	for i, link := range links {
		if link.ArchiveTarget != targets[i] {
			return ErrEpochConflict
		}
	}
	return nil
}
