package access

import "context"

func archiveRotationPreviousRecoveryPolicy(ctx context.Context, query SessionQuery, current State, head PolicyProof,
	record EpochRecord, actor Principal, identity RecoveryIdentity, cache *textChannelPolicyTreeCache) (*TextChannelPolicyDisclosure, error) {
	roleDeny := head.Draft.Action == EditScopedChannelACLRoleRules
	invite := head.Draft.Action == RedeemPolicyInvite
	if record.Purpose != ArchiveEpoch || (!roleDeny && !invite && head.Draft.Action != EditScopedChannelACLPersonal) ||
		head.Draft.TextProjectionVersion < TextGroupedArchiveRotationProjectionVersion ||
		identity.ID == "" || current.RecoveryIdentities[actor.ProfileID] != identity ||
		!canReadRecoveryEpoch(current, actor.ProfileID, record.ChannelID, ArchiveEpoch) {
		return nil, nil
	}
	recipients, err := current.rotationRecipients(record.ChannelID, ArchiveEpoch)
	if err != nil {
		return nil, err
	}
	task := RotationTask{EpochRecord: record, Recipients: recipients}
	if invite {
		basis, err := readInviteAdmissionRotationBasis(ctx, query, current, head, task, actor, cache)
		if err != nil {
			return nil, err
		}
		if basis != nil {
			valid, err := archiveInviteLiveSource(ctx, query, current, record, *basis.rotation, nil)
			if err != nil {
				return nil, err
			}
			if valid {
				return previousArchiveRecoveryDisclosure(basis.previous, current, basis.predecessor, record.ChannelID, actor.ProfileID, identity, cache)
			}
		}
		batch, err := readCurrentInviteAdmissionBatch(ctx, query, current, head, task, actor, cache, nil)
		if err != nil || batch == nil {
			return nil, err
		}
		previous, base, err := readInviteBatchPolicy(ctx, query, batch.PreviousRevision)
		if err != nil {
			return nil, err
		}
		return previousArchiveRecoveryDisclosure(previous, current, base, record.ChannelID, actor.ProfileID, identity, cache)
	}
	if roleDeny {
		basis, err := readRoleViewDenyBasis(ctx, query, current, head, task, actor, cache)
		if err != nil || basis == nil {
			return nil, err
		}
		return previousArchiveRecoveryDisclosure(basis.previous, current, basis.predecessor, record.ChannelID, actor.ProfileID, identity, cache)
	}
	evidence, err := personalDenyRotationEvidence(ctx, query, current, head,
		task, actor, cache)
	if err != nil || evidence == nil {
		return nil, err
	}
	previous, predecessor, err := readPrecedingPolicyState(ctx, query, head.Draft)
	if err != nil {
		return nil, err
	}
	return previousArchiveRecoveryDisclosure(previous, current, predecessor, record.ChannelID, actor.ProfileID, identity, cache)
}

func previousArchiveRecoveryDisclosure(previous, current State, predecessor PolicyProof, channel, profile string,
	identity RecoveryIdentity, cache *textChannelPolicyTreeCache) (*TextChannelPolicyDisclosure, error) {
	recipient := KeyRecipient{ProfileID: profile, Kind: "recovery", PublicKey: identity.AgreementKey}
	if previous.RecoveryIdentities[profile] != identity ||
		current.KeyRecipients[identity.ID] != recipient || previous.KeyRecipients[identity.ID] != recipient ||
		!canReadRecoveryEpoch(previous, profile, channel, ArchiveEpoch) ||
		previous.Admissions[channel][profile] != current.Admissions[channel][profile] {
		return nil, nil
	}
	return textChannelDisclosure(previous, predecessor, channel, identity.ID, cache, 0)
}
