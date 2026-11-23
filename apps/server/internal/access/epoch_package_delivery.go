package access

import (
	"context"
	"database/sql"
	"math"
	"slices"
)

type EpochPackageDelivery struct {
	Epoch                   EpochProof
	Package                 EpochPackage
	Proof                   EpochPackageProof
	TextPolicy              *TextChannelPolicyDisclosure      `json:"textPolicy,omitempty"`
	PreviousRecoveryPolicy  *TextChannelPolicyDisclosure      `json:"previousRecoveryPolicy,omitempty"`
	AdmissionPolicy         *TextChannelPolicyDisclosure      `json:"admissionPolicy,omitempty"`
	LiveInviteAdmission     *InviteAdmissionReadEvidence      `json:"liveInviteAdmission,omitempty"`
	ArchiveInviteAdmission  *InviteAdmissionReadEvidence      `json:"archiveInviteAdmission,omitempty"`
	LiveInviteAdmissions    *InviteAdmissionBatchReadEvidence `json:"liveInviteAdmissions,omitempty"`
	ArchiveInviteAdmissions *InviteAdmissionBatchReadEvidence `json:"archiveInviteAdmissions,omitempty"`
	LivePersonalDeny        *PersonalDenyReadEvidence         `json:"livePersonalDeny,omitempty"`
	ArchivePersonalDeny     *PersonalDenyReadEvidence         `json:"archivePersonalDeny,omitempty"`
	LiveRoleViewDeny        *RoleViewDenyReadEvidence         `json:"liveRoleViewDeny,omitempty"`
	ArchiveRoleViewDeny     *RoleViewDenyReadEvidence         `json:"archiveRoleViewDeny,omitempty"`
	RoleAssignment          *ScopedRoleAssignmentReadEvidence `json:"roleAssignment,omitempty"`
	LiveRoleHistory         *liveRoleHistoryEvidence          `json:"liveRoleHistory,omitempty"`
}

func (s State) canLoadEpoch(actor Principal, channel, purpose string) bool {
	recipient := s.KeyRecipients[actor.DeviceID]
	return recipient.Kind == "device" && recipient.ProfileID == actor.ProfileID &&
		s.CanDeliver(actor.ProfileID, channel, 0) && s.Channels[channel].Kind == "text" &&
		(purpose == LiveEpoch || s.CheckGrant(s.Members[actor.ProfileID], s.scope(s.Channels[channel]), "history.full", 0) == Allowed)
}

// LoadEpochProofPage returns signed commitments for continuity without any key packages.
func (s *Store) LoadEpochProofPage(ctx context.Context, resolve ResolveSession, channel, purpose string, after, through uint64) ([]EpochProof, error) {
	if (purpose != LiveEpoch && purpose != ArchiveEpoch) || after >= through || through >= math.MaxInt64 {
		return nil, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return nil, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return nil, err
	}
	return readEpochProofPage(ctx, tx, state, actor, channel, purpose, after, through)
}

func (s *Store) DispatchEpochProofPage(ctx context.Context, resolve ResolveSession, channel, purpose string, after, through uint64,
	verify VerifyEpochRecord, scoped *TextChannelPolicyProofCache, deliver func([]EpochProof) error) error {
	if (purpose != LiveEpoch && purpose != ArchiveEpoch) || after >= through || through >= math.MaxInt64 || verify == nil {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		proofs, err := readEpochProofPage(ctx, conn, state, actor, channel, purpose, after, through)
		if err != nil {
			return err
		}
		var archiveTransitions archiveTransitionProofs
		var signingPolicies historicalEpochSigningPolicies
		for i := range proofs {
			proof := &proofs[i]
			if err := verify(ctx, conn, proof.Principal, proof.Record); err != nil {
				return err
			}
			if scoped != nil {
				proof.SigningPolicy, err = signingPolicies.disclose(ctx, conn, scoped, *proof)
				if err != nil {
					return err
				}
				if purpose == ArchiveEpoch {
					if err := archiveTransitions.disclose(ctx, conn, state, actor, proof, verify); err != nil {
						return err
					}
				}
				if state.canLoadEpoch(actor, channel, ArchiveEpoch) ||
					retainedPersonalDenyReader(signingPolicies.basis, state, proof.Record, actor) {
					if err := setInviteAdmissionSigningProof(ctx, conn, &signingPolicies, proof, &scoped.history); err != nil {
						return err
					}
				}
				if signingPolicies.head.Draft.Action == EditScopedRoles &&
					(proof.Record.LiveTransitionDigest != "" || proof.Record.ArchiveTransitionDigest != "") {
					proof.RoleAssignment, err = scopedRoleAssignmentReadEvidence(ctx, conn, state, signingPolicies.basis, signingPolicies.head, *proof, actor, &scoped.history)
					if err != nil {
						return err
					}
				}
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(proofs)
	})
}

func readEpochProofPage(ctx context.Context, query epochDeliveryQuery, state State, actor Principal,
	channel, purpose string, after, through uint64) ([]EpochProof, error) {
	if !state.canLoadEpoch(actor, channel, purpose) {
		return nil, ChannelRestricted
	}
	if through > state.currentGeneration(channel, purpose) {
		return nil, ErrEpochStale
	}
	end := min(through, after+32)
	rows, err := query.QueryContext(ctx, `SELECT generation,key_id,digest,record FROM protected_epochs
		WHERE channel_id=? AND purpose=? AND generation>? AND generation<=? ORDER BY generation`, channel, purpose, after, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]EpochProof, 0, end-after)
	for rows.Next() {
		var generation uint64
		var key, digest string
		var raw []byte
		if err := rows.Scan(&generation, &key, &digest, &raw); err != nil {
			return nil, err
		}
		if generation != after+uint64(len(result))+1 {
			return nil, ErrEpochConflict
		}
		proof, err := decodeEpoch(raw, channel, purpose, key, digest, generation)
		if err != nil {
			return nil, err
		}
		result = append(result, proof)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if uint64(len(result)) != end-after {
		return nil, ErrEpochConflict
	}
	return result, nil
}

// LoadEpochPackage returns only the session device's own current package.
// Historical packages require a separate admission-bound contract.
func (s *Store) LoadEpochPackage(ctx context.Context, resolve ResolveSession, channel, keyID, purpose string) (EpochPackageDelivery, error) {
	var result EpochPackageDelivery
	if purpose != "live" && purpose != "archive" {
		return result, InvalidAction
	}
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
	recipient := state.KeyRecipients[actor.DeviceID]
	if !state.canLoadEpoch(actor, channel, purpose) {
		return result, ChannelRestricted
	}
	epoch, err := readEpoch(ctx, tx, channel, purpose, keyID)
	if err != nil {
		return result, err
	}
	if epoch.Record.Generation != state.currentGeneration(channel, purpose) ||
		purpose == LiveEpoch && !state.EpochWindows[channel].Accepts(epoch.Record.Generation, s.now().UnixMilli()) {
		return result, ErrEpochStale
	}
	return readOwnEpochPackage(ctx, tx, actor.DeviceID, recipient.PublicKey, epoch)
}

func (s *Store) LoadRotationTargetPackage(ctx context.Context, resolve ResolveSession, record EpochRecord, target ArchiveTarget) (EpochPackageDelivery, error) {
	var result EpochPackageDelivery
	err := s.DispatchRotationTargetPackages(ctx, resolve, record, []ArchiveTarget{target}, nil, nil, func(packages []EpochPackageDelivery) error {
		result = packages[0]
		return nil
	})
	return result, err
}

func (s *Store) DispatchRotationTargetPackages(ctx context.Context, resolve ResolveSession, record EpochRecord, requested []ArchiveTarget,
	verify VerifyEpochRecord, scoped *TextChannelPolicyProofCache, deliver func([]EpochPackageDelivery) error) error {
	return s.dispatchRotationTargetPackages(ctx, resolve, record, requested, verify, scoped, false, deliver)
}

func (s *Store) DispatchRotationRecoveryTargetPackages(ctx context.Context, resolve ResolveSession, record EpochRecord, requested []ArchiveTarget,
	verify VerifyEpochRecord, scoped *TextChannelPolicyProofCache, deliver func([]EpochPackageDelivery) error) error {
	if verify == nil {
		return InvalidAction
	}
	return s.dispatchRotationTargetPackages(ctx, resolve, record, requested, verify, scoped, true, deliver)
}

func (s *Store) dispatchRotationTargetPackages(ctx context.Context, resolve ResolveSession, record EpochRecord, requested []ArchiveTarget,
	verify VerifyEpochRecord, scoped *TextChannelPolicyProofCache, useRecovery bool, deliver func([]EpochPackageDelivery) error) error {
	if record.Purpose != ArchiveEpoch || !validRotationID(record.TaskID) || !validRotationID(record.LeaseID) ||
		len(requested) == 0 || len(requested) > 8 {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		channel := record.ChannelID
		if !state.canLoadEpoch(actor, channel, ArchiveEpoch) {
			return ChannelRestricted
		}
		var revision int64
		if err := conn.QueryRowContext(ctx, "SELECT revision FROM protected_policy WHERE id=1").Scan(&revision); err != nil {
			return err
		}
		if revision != record.Revision || state.ArchiveHeads[channel]+1 != record.Generation {
			return ErrPolicyConflict
		}
		now := s.now().UnixMilli()
		through, err := verifyRotationLease(ctx, conn, actor, record, now)
		if err != nil {
			return err
		}
		covered, err := previousArchiveCoverage(ctx, conn, channel, record.Generation)
		if err != nil {
			return err
		}
		if through != record.ArchiveThrough || through < covered || through-covered > archiveBatchSize {
			return ErrEpochConflict
		}
		targets, err := archiveTargets(ctx, conn, channel, record.Generation, covered, through)
		if err != nil {
			return err
		}
		var identity RecoveryIdentity
		var head PolicyProof
		var basis recoveryEpochBasis
		var disclosure *TextChannelPolicyDisclosure
		var previousRecoveryPolicy *TextChannelPolicyDisclosure
		var checkedPreviousRecovery bool
		if useRecovery {
			identity, err = currentRecoveryIdentity(state, actor, now)
			if err != nil {
				return err
			}
			if identity.ID == "" {
				return ErrEpochRecipients
			}
			head, err = ReadPolicyHead(ctx, conn, &actor)
			if err != nil {
				return err
			}
			basis = recoveryEpochBasis{revision: head.Draft.Revision, digest: head.Draft.ResultDigest, state: state}
		}
		deliveries := make([]EpochPackageDelivery, 0, len(requested))
		var archiveTransitions archiveTransitionProofs
		var signingPolicies historicalEpochSigningPolicies
		for _, target := range requested {
			if !slices.Contains(targets, target) {
				return ErrEpochRecipients
			}
			var epoch EpochProof
			recipientID, recipientKey := actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey
			var recoveryTarget bool
			if useRecovery {
				addressed, err := hasAddressedEpochPackage(ctx, conn, channel, recipientID, recipientKey, target)
				if err != nil {
					return err
				}
				recoveryTarget = !addressed
			}
			if recoveryTarget {
				packet, err := readRecoveryEpochWitness(ctx, conn, state, actor.ProfileID, identity,
					RecoveryCoverageItem{ChannelID: channel, Purpose: target.Purpose, Generation: target.Generation}, &basis)
				if err != nil {
					return err
				}
				if packet.packageDigest == "" || packet.epoch.Record.KeyID != target.KeyID {
					return ErrEpochRecipients
				}
				epoch = packet.epoch
				recipientID, recipientKey = identity.ID, identity.AgreementKey
			} else {
				epoch, err = readEpoch(ctx, conn, channel, target.Purpose, target.KeyID)
				if err != nil {
					return err
				}
			}
			if verify != nil {
				if err := verify(ctx, conn, epoch.Principal, epoch.Record); err != nil {
					return err
				}
			}
			if scoped != nil {
				epoch.SigningPolicy, err = signingPolicies.disclose(ctx, conn, scoped, epoch)
				if err != nil {
					return err
				}
				if recoveryTarget && target.Purpose == LiveEpoch && epoch.Record.Revision == record.Revision &&
					epoch.Record.LiveTransitionDigest != "" && signingPolicies.head.Draft.Action == RedeemPolicyInvite {
					return ErrEpochRecipients
				}
			}
			delivery, err := readOwnEpochPackage(ctx, conn, recipientID, recipientKey, epoch)
			if err != nil {
				return err
			}
			if scoped != nil && verify != nil {
				if err := setInviteAdmissionSigningProof(ctx, conn, &signingPolicies, &delivery.Epoch, &scoped.history); err != nil {
					return err
				}
				if !recoveryTarget && signingPolicies.head.Draft.Action == EditScopedRoles &&
					(epoch.Record.LiveTransitionDigest != "" || epoch.Record.ArchiveTransitionDigest != "") {
					delivery.RoleAssignment, err = scopedRoleAssignmentReadEvidence(ctx, conn, state, signingPolicies.basis, signingPolicies.head, epoch, actor, &scoped.history)
					if err != nil {
						return err
					}
				}
			}
			if recoveryTarget && scoped != nil {
				if disclosure == nil {
					disclosure, err = textChannelDisclosure(state, head, channel, recipientID, &scoped.current, 0)
					if err != nil {
						return err
					}
				}
				if disclosure == nil || disclosure.Recipient == nil {
					return ErrPolicyAttestationUnavailable
				}
				delivery.TextPolicy = disclosure
				if epoch.Record.Revision < head.Draft.Revision {
					if !checkedPreviousRecovery {
						previousRecoveryPolicy, err = archiveRotationPreviousRecoveryPolicy(ctx, conn, state, head,
							record, actor, identity, &scoped.history)
						if err != nil {
							return err
						}
						checkedPreviousRecovery = true
					}
					delivery.PreviousRecoveryPolicy = previousRecoveryPolicy
				}
			}
			if scoped != nil && verify != nil && !recoveryTarget && target.Purpose == LiveEpoch && epoch.Record.Revision == record.Revision &&
				epoch.Record.LiveTransitionDigest != "" {
				if head.Digest == "" {
					head, err = readPolicyHead(ctx, conn)
					if err != nil {
						return err
					}
				}
				if head.Draft.Action == EditScopedChannelACLRoleRules {
					transition, readErr := verifiedRoleViewDenyBasis(ctx, conn, state, head, epoch.Record, actor, &scoped.history)
					if readErr != nil {
						return readErr
					}
					if transition != nil {
						delivery.LiveRoleViewDeny, err = transition.disclose(state, epoch, &scoped.history)
					}
				} else if head.Draft.Action != RedeemPolicyInvite {
					delivery.LivePersonalDeny, err = personalDenyReadEvidence(ctx, conn, state, epoch, actor, &scoped.history)
				}
				if err != nil {
					return err
				}
			}
			if scoped != nil && verify != nil && !recoveryTarget && target.Purpose == ArchiveEpoch && epoch.Record.Revision == record.Revision {
				if err := archiveTransitions.disclose(ctx, conn, state, actor, &delivery.Epoch, verify); err != nil {
					return err
				}
			}
			deliveries = append(deliveries, delivery)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(deliveries)
	})
}

type epochDeliveryQuery interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readOwnEpochPackage(ctx context.Context, tx epochDeliveryQuery, deviceID, publicKey string, epoch EpochProof) (EpochPackageDelivery, error) {
	var result EpochPackageDelivery
	channel, purpose := epoch.Record.ChannelID, epoch.Record.Purpose
	rows, err := tx.QueryContext(ctx, `SELECT recipient_id,purpose,ciphertext,recipient_key FROM protected_epoch_packages
	    WHERE channel_id=? AND generation=? AND purpose=? LIMIT 8193`, channel, epoch.Record.Generation, purpose)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	var packages []EpochPackage
	for rows.Next() {
		var entry EpochPackage
		var issuedTo string
		if err := rows.Scan(&entry.RecipientID, &entry.Purpose, &entry.Ciphertext, &issuedTo); err != nil {
			return EpochPackageDelivery{}, err
		}
		packages = append(packages, entry)
		if entry.RecipientID == deviceID && entry.Purpose == purpose && issuedTo == publicKey {
			result.Package = entry
		}
	}
	if err := rows.Err(); err != nil {
		return EpochPackageDelivery{}, err
	}
	if result.Package.RecipientID == "" {
		return EpochPackageDelivery{}, ErrEpochRecipients
	}
	digest, proof, err := ProveEpochPackage(packages, deviceID, purpose)
	if err != nil || digest != epoch.Record.PackagesDigest {
		return EpochPackageDelivery{}, ErrEpochConflict
	}
	result.Epoch, result.Proof = epoch, proof
	return result, nil
}

func (s *Store) DispatchCurrentEpochPackage(ctx context.Context, resolve ResolveSession, channel, purpose string,
	verify VerifyEpochRecord, cache *TextChannelPolicyProofCache, scoped bool, sign SignLiveRoleHistoryReceipt,
	deliver func(EpochPackageDelivery) error) error {
	if (purpose != LiveEpoch && purpose != ArchiveEpoch) || verify == nil {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canLoadEpoch(actor, channel, purpose) {
			return ChannelRestricted
		}
		generation := state.currentGeneration(channel, purpose)
		if generation == 0 || purpose == LiveEpoch && !state.EpochWindows[channel].Accepts(generation, s.now().UnixMilli()) {
			return ErrEpochStale
		}
		var key string
		if err := conn.QueryRowContext(ctx, `SELECT key_id FROM protected_epochs
			WHERE channel_id=? AND purpose=? AND generation=?`, channel, purpose, generation).Scan(&key); err != nil {
			return err
		}
		proof, err := readEpoch(ctx, conn, channel, purpose, key)
		if err != nil {
			return err
		}
		if err := verify(ctx, conn, proof.Principal, proof.Record); err != nil {
			return err
		}
		var signedState State
		var signedHead PolicyProof
		if scoped {
			signedState, signedHead, err = readHistoricalTextSignerBasis(ctx, conn, proof.Record)
			if err != nil {
				return err
			}
			proof.SigningPolicy, err = historicalTextSignerDisclosure(signedState, signedHead, proof.Record, proof.Principal, purpose, cache)
			if err != nil {
				return err
			}
		}
		var admission livePackagePolicyBasis
		if purpose == LiveEpoch && !state.canLoadEpoch(actor, channel, ArchiveEpoch) {
			admission, err = checkLivePackageAdmission(ctx, conn, state, actor, proof.Record)
			if err != nil {
				if err == ChannelRestricted {
					return ErrEpochRecipients
				}
				return err
			}
		}
		delivery, err := readOwnEpochPackage(ctx, conn, actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey, proof)
		if err != nil {
			return err
		}
		err = setEpochPackagePolicy(ctx, conn, state, actor, &delivery, admission, cache)
		if err != nil {
			return err
		}
		if scoped && (proof.Record.LiveTransitionDigest != "" || proof.Record.ArchiveTransitionDigest != "") {
			switch {
			case signedHead.Draft.Action == EditScopedRoles:
				delivery.RoleAssignment, err = scopedRoleAssignmentReadEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			case purpose == LiveEpoch && proof.inviteAdmissionBaseRevision != 0:
				delivery.LiveInviteAdmissions, err = inviteAdmissionBatchPackageEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			case purpose == ArchiveEpoch && proof.inviteAdmissionBaseRevision != 0:
				delivery.ArchiveInviteAdmissions, err = inviteAdmissionBatchPackageEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			case purpose == LiveEpoch && signedHead.Draft.Action == RedeemPolicyInvite:
				delivery.LiveInviteAdmission, err = inviteAdmissionPackageEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			case purpose == ArchiveEpoch && signedHead.Draft.Action == RedeemPolicyInvite:
				delivery.ArchiveInviteAdmission, err = inviteAdmissionPackageEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			case purpose == LiveEpoch && signedHead.Draft.Action == EditScopedChannelACLRoleRules:
				delivery.LiveRoleViewDeny, err = currentRoleViewDenyEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			case purpose == LiveEpoch:
				delivery.LivePersonalDeny, err = currentPersonalDenyReadEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			case signedHead.Draft.Action == EditScopedChannelACLRoleRules:
				delivery.ArchiveRoleViewDeny, err = currentRoleViewDenyEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			default:
				delivery.ArchivePersonalDeny, err = currentPersonalDenyReadEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			}
			if err != nil {
				return err
			}
		}
		if scoped && purpose == LiveEpoch && delivery.TextPolicy != nil && delivery.TextPolicy.RoleRulesDigest != "" {
			delivery.LiveRoleHistory, err = readLiveRoleHistoryEvidence(ctx, conn, state, proof.Record, actor, verify, sign, &cache.history)
			if err != nil {
				return err
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(delivery)
	})
}

// DispatchAdmittedLivePackage delivers an older, originally addressed package
// only when its signed policy records the device's current content interval.
func (s *Store) DispatchAdmittedLivePackage(ctx context.Context, resolve ResolveSession, channel, key string,
	verify VerifyEpochRecord, cache *TextChannelPolicyProofCache, scoped bool, deliver func(EpochPackageDelivery) error) error {
	if verify == nil {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canLoadEpoch(actor, channel, LiveEpoch) {
			return ChannelRestricted
		}
		proof, err := readEpoch(ctx, conn, channel, LiveEpoch, key)
		if err != nil {
			return err
		}
		if proof.Record.Generation > state.currentGeneration(channel, LiveEpoch) {
			return ErrEpochStale
		}
		if err := verify(ctx, conn, proof.Principal, proof.Record); err != nil {
			return err
		}
		var signedState State
		var signedHead PolicyProof
		if scoped {
			signedState, signedHead, err = readHistoricalTextSignerBasis(ctx, conn, proof.Record)
			if err != nil {
				return err
			}
			proof.SigningPolicy, err = historicalTextSignerDisclosure(signedState, signedHead, proof.Record, proof.Principal, LiveEpoch, cache)
			if err != nil {
				return err
			}
		}
		admission, err := checkLivePackageAdmission(ctx, conn, state, actor, proof.Record)
		if err != nil {
			return err
		}
		delivery, err := readOwnEpochPackage(ctx, conn, actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey, proof)
		if err != nil {
			return err
		}
		err = setEpochPackagePolicy(ctx, conn, state, actor, &delivery, admission, cache)
		if err != nil {
			return err
		}
		if scoped && proof.Record.LiveTransitionDigest != "" && signedHead.Draft.Action == RedeemPolicyInvite {
			if proof.inviteAdmissionBaseRevision != 0 {
				delivery.LiveInviteAdmissions, err = inviteAdmissionBatchPackageEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			} else {
				delivery.LiveInviteAdmission, err = inviteAdmissionPackageEvidence(ctx, conn, state, signedState, signedHead, proof, actor, &cache.history)
			}
			if err != nil {
				return err
			}
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(delivery)
	})
}

type livePackagePolicyBasis struct {
	state State
	proof PolicyProof
}

func checkLivePackageAdmission(ctx context.Context, query SessionQuery, state State, actor Principal,
	record EpochRecord) (livePackagePolicyBasis, error) {
	channel := record.ChannelID
	admission := state.Admissions[channel][actor.ProfileID]
	if admission.FirstPosition == 0 {
		return livePackagePolicyBasis{}, ChannelRestricted
	}
	basis, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy_proofs WHERE revision=?", record.Revision))
	if err != nil {
		return livePackagePolicyBasis{}, err
	}
	digest, err := basis.PolicyDigest()
	if err != nil || digest != record.PolicyDigest {
		return livePackagePolicyBasis{}, ErrPolicyConflict
	}
	if basis.Admissions[channel][actor.ProfileID] != admission || !basis.canLoadEpoch(actor, channel, LiveEpoch) ||
		basis.KeyRecipients[actor.DeviceID] != state.KeyRecipients[actor.DeviceID] {
		return livePackagePolicyBasis{}, ChannelRestricted
	}
	proof, err := readStoredPolicyProof(ctx, query, query.QueryRowContext(ctx,
		"SELECT revision,operation_id,digest,record FROM protected_policy_proofs WHERE revision=?", record.Revision))
	if err != nil {
		return livePackagePolicyBasis{}, err
	}
	if proof.Draft.ResultDigest != record.PolicyDigest {
		return livePackagePolicyBasis{}, ErrPolicyConflict
	}
	return livePackagePolicyBasis{state: basis, proof: proof}, nil
}

func setEpochPackagePolicy(ctx context.Context, query SessionQuery, state State, actor Principal, delivery *EpochPackageDelivery,
	admission livePackagePolicyBasis, cache *TextChannelPolicyProofCache) error {
	record := delivery.Epoch.Record
	current, err := currentTextChannelDisclosure(ctx, query, state, record.ChannelID, actor.DeviceID, cache)
	if err != nil {
		return err
	}
	delivery.TextPolicy = current
	version := admission.proof.Draft.TextProjectionVersion
	if HasTextRecipientProjection(version) &&
		(current == nil || record.Revision != current.Revision) {
		delivery.AdmissionPolicy, err = textChannelDisclosure(admission.state, admission.proof, record.ChannelID, actor.DeviceID, &cache.history, 0)
		return err
	}
	return nil
}

// VerifyInitialEpochStorage rechecks committed packages and backward links before
// using a generation as part of a cutover commitment.
func VerifyInitialEpochStorage(ctx context.Context, tx *sql.Tx, epoch EpochProof) error {
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	record, actor := epoch.Record, epoch.Principal
	if !state.PolicyAnchored || revision != 1 || record.Revision != revision || record.Generation != 1 ||
		state.currentGeneration(record.ChannelID, record.Purpose) != 1 || !state.canLoadEpoch(actor, record.ChannelID, record.Purpose) {
		return ErrEpochConflict
	}
	digest, err := state.PolicyDigest()
	if err != nil {
		return err
	}
	if record.PolicyDigest != digest || record.PreviousDigest != "" {
		return ErrPolicyConflict
	}
	if _, err := readOwnEpochPackage(ctx, tx, actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey, epoch); err != nil {
		return err
	}
	if record.Purpose == LiveEpoch {
		return checkArchiveLinks(ctx, tx, state, record, nil)
	}
	links, err := readArchiveLinks(ctx, tx, record.ChannelID, record.Generation)
	if err != nil {
		return err
	}
	return checkArchiveLinks(ctx, tx, state, record, links)
}
