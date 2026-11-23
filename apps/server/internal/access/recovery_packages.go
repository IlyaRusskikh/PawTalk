package access

import (
	"context"
	"database/sql"
	"errors"
	"maps"
	"slices"
)

// RecoveryCoverage describes available current packets for one profile. The
// client still verifies and opens each packet before confirming recovery.
type RecoveryCoverage struct {
	RecoveryID string                 `json:"recoveryId"`
	PolicyHead string                 `json:"policyHead"`
	Items      []RecoveryCoverageItem `json:"items"`
}

type RecoveryCoverageItem struct {
	ChannelID     string `json:"channelId"`
	Purpose       string `json:"purpose"`
	Generation    uint64 `json:"generation"`
	EpochDigest   string `json:"epochDigest"`
	PackageDigest string `json:"packageDigest"`
	Pending       bool   `json:"pending"`
}

const maxRecoveryCoverageItems = 2 * 1000 // Two purposes per channel at the room channel limit.

func (s *Store) DispatchRecoveryCoverage(ctx context.Context, resolve ResolveSession, deliver func(RecoveryCoverage) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		now := s.now().UnixMilli()
		identity, err := currentRecoveryIdentity(state, actor, now)
		if err != nil {
			return err
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		result := RecoveryCoverage{RecoveryID: identity.ID, PolicyHead: head.Digest, Items: []RecoveryCoverageItem{}}
		if identity.ID == "" {
			return deliver(result)
		}
		basis := recoveryEpochBasis{revision: head.Draft.Revision, digest: head.Draft.ResultDigest, state: state}
		for _, channel := range slices.Sorted(maps.Keys(state.Channels)) {
			for _, purpose := range []string{LiveEpoch, ArchiveEpoch} {
				if !canReadRecoveryEpoch(state, actor.ProfileID, channel, purpose) {
					continue
				}
				if len(result.Items) == maxRecoveryCoverageItems {
					return InvalidPolicy
				}
				item := RecoveryCoverageItem{ChannelID: channel, Purpose: purpose,
					Generation: state.currentGeneration(channel, purpose), Pending: true}
				packet, err := readRecoveryEpochCandidate(ctx, conn, state, actor.ProfileID, identity, item, now, &basis)
				if err != nil {
					return err
				}
				if packet.packageDigest != "" {
					item.EpochDigest, item.PackageDigest, item.Pending = packet.epochDigest, packet.packageDigest, false
				}
				result.Items = append(result.Items, item)
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(result)
	})
}

func (s *Store) DispatchRecoveryPackage(ctx context.Context, resolve ResolveSession, channel, purpose string,
	verify VerifyEpochRecord, cache *TextChannelPolicyProofCache, scoped bool, deliver func(EpochPackageDelivery) error) error {
	return s.dispatchRecoveryPackage(ctx, resolve, channel, purpose, "", verify, cache, scoped, deliver)
}

// DispatchAdmittedRecoveryLivePackage restores only a limited-history member's
// originally addressed live package from the same continuous admission.
func (s *Store) DispatchAdmittedRecoveryLivePackage(ctx context.Context, resolve ResolveSession, channel, key string,
	verify VerifyEpochRecord, cache *TextChannelPolicyProofCache, scoped bool, deliver func(EpochPackageDelivery) error) error {
	if !isDigest(key) {
		return InvalidAction
	}
	return s.dispatchRecoveryPackage(ctx, resolve, channel, LiveEpoch, key, verify, cache, scoped, deliver)
}

func (s *Store) dispatchRecoveryPackage(ctx context.Context, resolve ResolveSession, channel, purpose, admittedKey string,
	verify VerifyEpochRecord, cache *TextChannelPolicyProofCache, scoped bool, deliver func(EpochPackageDelivery) error) error {
	if (purpose != LiveEpoch && purpose != ArchiveEpoch) || verify == nil || cache == nil {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		now := s.now().UnixMilli()
		identity, err := currentRecoveryIdentity(state, actor, now)
		if err != nil {
			return err
		}
		fullHistory := canReadRecoveryEpoch(state, actor.ProfileID, channel, ArchiveEpoch)
		if !canReadRecoveryEpoch(state, actor.ProfileID, channel, purpose) || admittedKey != "" && fullHistory {
			return ChannelRestricted
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		item := RecoveryCoverageItem{ChannelID: channel, Purpose: purpose, Generation: state.currentGeneration(channel, purpose)}
		basis := recoveryEpochBasis{revision: head.Draft.Revision, digest: head.Draft.ResultDigest, state: state}
		var packet recoveryEpochCandidate
		if admittedKey == "" {
			packet, err = readRecoveryEpochCandidate(ctx, conn, state, actor.ProfileID, identity, item, now, &basis)
		} else {
			proof, err := readEpoch(ctx, conn, channel, LiveEpoch, admittedKey)
			if err != nil {
				return err
			}
			if proof.Record.Generation > item.Generation {
				return ErrEpochStale
			}
			item.Generation = proof.Record.Generation
			packet, err = readRecoveryEpochWitness(ctx, conn, state, actor.ProfileID, identity, item, &basis)
			if err != nil {
				return err
			}
			if packet.packageDigest != "" && packet.epoch.Record.KeyID != admittedKey {
				return ErrEpochConflict
			}
		}
		if err != nil {
			return err
		}
		if packet.packageDigest == "" {
			return ErrEpochRecipients
		}
		epoch := packet.epoch
		if err := verify(ctx, conn, epoch.Principal, epoch.Record); err != nil {
			return err
		}
		if scoped {
			epoch.SigningPolicy, err = historicalTextSigner(ctx, conn, cache, epoch.Record, epoch.Principal, purpose)
			if err != nil {
				return err
			}
		}
		delivery, err := readOwnEpochPackage(ctx, conn, identity.ID, identity.AgreementKey, epoch)
		if err != nil {
			return err
		}
		delivery.TextPolicy, err = textChannelDisclosure(state, head, channel, identity.ID, &cache.current, 0)
		if err != nil {
			return err
		}
		if scoped && (delivery.TextPolicy == nil || delivery.TextPolicy.Recipient == nil) {
			return ErrPolicyAttestationUnavailable
		}
		if purpose == LiveEpoch && !fullHistory {
			historicalHead, err := readAttestedProof(ctx, conn, epoch.Record.Revision)
			if err != nil {
				return err
			}
			if historicalHead.Draft.ResultDigest != epoch.Record.PolicyDigest {
				return ErrPolicyConflict
			}
			delivery.AdmissionPolicy, err = textChannelDisclosure(basis.state, historicalHead, channel, identity.ID, &cache.history, 0)
			if err != nil {
				return err
			}
			if scoped && (delivery.AdmissionPolicy == nil || delivery.AdmissionPolicy.Recipient == nil) {
				return ErrPolicyAttestationUnavailable
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(delivery)
	})
}

func currentRecoveryIdentity(state State, actor Principal, now int64) (RecoveryIdentity, error) {
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
		return RecoveryIdentity{}, Inactive
	}
	if removal := state.MemberRemovals[actor.ProfileID]; removal.BannedAt(now) {
		return RecoveryIdentity{}, MemberBanError{removal}
	}
	identity := state.RecoveryIdentities[actor.ProfileID]
	if identity.ID != "" && state.KeyRecipients[identity.ID] != (KeyRecipient{
		ProfileID: actor.ProfileID, Kind: "recovery", PublicKey: identity.AgreementKey,
	}) {
		return RecoveryIdentity{}, ErrPolicyConflict
	}
	return identity, nil
}

func canReadRecoveryEpoch(state State, profile, channel, purpose string) bool {
	entry := state.Channels[channel]
	return entry.Kind == "text" && state.CanDeliver(profile, channel, 0) &&
		state.Admissions[channel][profile].FirstPosition != 0 &&
		(purpose == LiveEpoch || state.CheckGrant(state.Members[profile], state.scope(entry), "history.full", 0) == Allowed)
}

type recoveryEpochCandidate struct {
	epoch         EpochProof
	epochDigest   string
	packageDigest string
	openingKey    [RecoveryEpochOpeningKeySize]byte
}

// Keep one historical snapshot per dispatch even if each channel was rotated
// under a different revision.
type recoveryEpochBasis struct {
	revision int64
	digest   string
	state    State
}

func (basis *recoveryEpochBasis) read(ctx context.Context, query SessionQuery, record EpochRecord) error {
	if basis.revision == record.Revision && basis.digest == record.PolicyDigest {
		return nil
	}
	state, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy_proofs WHERE revision=?", record.Revision))
	if err != nil {
		return err
	}
	digest, err := state.PolicyDigest()
	if err != nil || digest != record.PolicyDigest {
		return ErrPolicyConflict
	}
	*basis = recoveryEpochBasis{revision: record.Revision, digest: digest, state: state}
	return nil
}

func readRecoveryEpochCandidate(ctx context.Context, query SessionQuery, state State, profile string, identity RecoveryIdentity,
	item RecoveryCoverageItem, now int64, basis *recoveryEpochBasis) (recoveryEpochCandidate, error) {
	if item.Purpose == LiveEpoch && !state.EpochWindows[item.ChannelID].Accepts(item.Generation, now) {
		return recoveryEpochCandidate{}, nil
	}
	return readRecoveryEpochWitness(ctx, query, state, profile, identity, item, basis)
}

func readRecoveryEpochWitness(ctx context.Context, query SessionQuery, state State, profile string, identity RecoveryIdentity,
	item RecoveryCoverageItem, basis *recoveryEpochBasis) (recoveryEpochCandidate, error) {
	var result recoveryEpochCandidate
	if identity.ID == "" || item.Generation == 0 {
		return result, nil
	}
	channel, purpose := item.ChannelID, item.Purpose
	var key, digest string
	var raw, ciphertext []byte
	err := query.QueryRowContext(ctx, `SELECT e.key_id,e.digest,e.record,p.ciphertext
		FROM protected_epochs e JOIN protected_epoch_packages p USING(channel_id,purpose,generation)
		WHERE e.channel_id=? AND e.purpose=? AND e.generation=? AND p.recipient_id=? AND p.recipient_key=?`,
		channel, purpose, item.Generation, identity.ID, identity.AgreementKey).Scan(&key, &digest, &raw, &ciphertext)
	if errors.Is(err, sql.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if len(ciphertext) != RecoveryEpochPackageSize {
		return result, nil
	}
	openingKey := ciphertext[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:]
	if !ValidRecoveryEpochOpeningKey(openingKey) {
		return result, nil
	}
	epoch, err := decodeEpoch(raw, channel, purpose, key, digest, item.Generation)
	if err != nil {
		return result, err
	}
	if err := basis.read(ctx, query, epoch.Record); err != nil {
		return result, err
	}
	if basis.state.RecoveryIdentities[profile] != identity || !canReadRecoveryEpoch(basis.state, profile, channel, purpose) {
		return result, nil
	}
	if purpose == LiveEpoch && !canReadRecoveryEpoch(state, profile, channel, ArchiveEpoch) &&
		basis.state.Admissions[channel][profile] != state.Admissions[channel][profile] {
		return result, nil
	}
	return recoveryEpochCandidate{
		epoch: epoch, epochDigest: digest, packageDigest: hexHash(ciphertext), openingKey: [RecoveryEpochOpeningKeySize]byte(openingKey),
	}, nil
}
