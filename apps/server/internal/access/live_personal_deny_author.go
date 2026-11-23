package access

import (
	"context"
	"encoding/hex"
)

type liveMessageAuthorBasis struct {
	epoch       EpochRecord
	successor   State
	head        PolicyProof
	previous    State
	predecessor PolicyProof
	excluded    map[string]bool
	newcomers   map[Principal]uint64
	roleTarget  string
}

func addLiveMessageAuthorEvidence(ctx context.Context, query SessionQuery, channel string, cache *TextChannelPolicyProofCache,
	messages []LiveMessage, verify VerifyEpochRecord) error {
	type authorEvidence struct {
		current, previous *TextChannelPolicyDisclosure
		roleAssignmentKey *profileSigningKeyOpening
	}
	rowsByKey := make(map[string][]int)
	keys := make([]string, 0)
	for i, message := range messages {
		if message.PollResult == nil {
			key := message.Packet.KeyID
			if len(rowsByKey[key]) == 0 {
				keys = append(keys, key)
			}
			rowsByKey[key] = append(rowsByKey[key], i)
		}
	}
	var previousTree textChannelPolicyTreeCache
	for _, key := range keys {
		basis, err := readLiveMessageAuthorBasis(ctx, query, channel, key, &previousTree, verify)
		if err != nil {
			return err
		}
		authors := make(map[Principal]authorEvidence)
		for _, i := range rowsByKey[key] {
			message := &messages[i]
			if first := basis.newcomers[message.Author]; first != 0 &&
				(message.Position < first || message.Generation != basis.epoch.Generation) {
				return ErrEpochConflict
			}
			proof, found := authors[message.Author]
			if !found {
				proof.current, err = historicalTextSignerDisclosure(basis.successor, basis.head, basis.epoch, message.Author, LiveEpoch, cache)
				if err != nil {
					return err
				}
				proof.previous, err = basis.previousAuthorDisclosure(message.Author, &previousTree)
				if err != nil {
					return err
				}
				proof.roleAssignmentKey, err = basis.roleAssignmentAuthorKey(message.Author)
				if err != nil {
					return err
				}
				authors[message.Author] = proof
			}
			if proof.roleAssignmentKey != nil &&
				(proof.current == nil || proof.current.Recipient == nil || message.Generation != basis.epoch.Generation ||
					message.Position < proof.current.Recipient.Statement.FirstPosition) {
				return ErrEpochConflict
			}
			message.AuthorPolicy = proof.current
			message.PreviousAuthorPolicy = proof.previous
			message.RoleAssignmentAuthorKey = proof.roleAssignmentKey
		}
	}
	return nil
}

func (basis *liveMessageAuthorBasis) roleAssignmentAuthorKey(author Principal) (*profileSigningKeyOpening, error) {
	channel := basis.epoch.ChannelID
	if basis.roleTarget != author.ProfileID || basis.roleTarget == "" ||
		basis.previous.Admissions[channel][author.ProfileID].FirstPosition != 0 {
		return nil, nil
	}
	var seed [32]byte
	seedHex := basis.predecessor.Draft.TextProjectionSeed
	if !isDigest(seedHex) {
		return nil, ErrPolicyConflict
	}
	_, _ = hex.Decode(seed[:], []byte(seedHex))
	previous := basis.previous
	profile := previous.profileRoleAuthority(seed, previous.Members[author.ProfileID], scopedRoleKeys(previous)[author.ProfileID])
	_, opening, err := profile.keyTree(author.DeviceID)
	if err != nil {
		return nil, err
	}
	if opening == nil {
		return nil, ErrPolicyConflict
	}
	return opening, nil
}

func readLiveMessageAuthorBasis(ctx context.Context, query SessionQuery, channel, key string, previousTree *textChannelPolicyTreeCache,
	verify VerifyEpochRecord) (*liveMessageAuthorBasis, error) {
	epoch, err := readEpoch(ctx, query, channel, LiveEpoch, key)
	if err != nil {
		return nil, err
	}
	successor, head, err := readHistoricalTextSignerBasis(ctx, query, epoch.Record)
	if err != nil {
		return nil, err
	}
	basis := &liveMessageAuthorBasis{epoch: epoch.Record, successor: successor, head: head}
	if verify == nil || epoch.Record.LiveTransitionDigest == "" || verify(ctx, query, epoch.Principal, epoch.Record) != nil {
		return basis, nil
	}
	if head.Draft.Action == RedeemPolicyInvite {
		if epoch.inviteAdmissionBaseRevision != 0 {
			batch, err := readInviteAdmissionBatchEpochBasis(ctx, query, successor, head, epoch, previousTree)
			if err != nil {
				return basis, err
			}
			basis.previous, basis.predecessor = batch.previous, batch.base
			basis.excluded = map[string]bool{}
			basis.newcomers = make(map[Principal]uint64, len(batch.evidence.Admissions))
			for _, item := range batch.evidence.Admissions {
				basis.newcomers[item.Draft.Actor] = item.NewcomerTextPolicy.Recipient.Statement.FirstPosition
			}
			return basis, nil
		}
		invite, err := readInviteAdmissionEpochBasis(ctx, query, successor, head, epoch, previousTree)
		if err != nil || invite == nil {
			return basis, err
		}
		basis.previous, basis.predecessor = invite.previous, invite.predecessor
		basis.excluded = map[string]bool{}
		basis.newcomers = map[Principal]uint64{
			invite.rotation.Draft.Actor: invite.rotation.NewcomerTextPolicy.Recipient.Statement.FirstPosition,
		}
		return basis, nil
	}
	if head.Draft.Action == EditScopedChannelACLRoleRules {
		role, err := verifiedLiveRoleViewDenyBasis(ctx, query, successor, head, epoch.Record, epoch.Principal, previousTree)
		if err != nil || role == nil {
			return basis, err
		}
		basis.previous, basis.predecessor = role.previous, role.predecessor
		basis.excluded = make(map[string]bool, len(role.rotation.Effect.ExcludedProfiles))
		for _, profile := range role.rotation.Effect.ExcludedProfiles {
			basis.excluded[profile] = true
		}
		return basis, nil
	}
	if head.Draft.Action == EditScopedRoles && head.Draft.TextProjectionVersion == ProfileRoleAuthorityProjectionVersion {
		digest, err := scopedRoleAssignmentEpochDigest(epoch.Record, head)
		if err != nil || digest != epoch.Record.LiveTransitionDigest {
			return basis, err
		}
		basis.previous, basis.predecessor, err = readAttestedRoleAssignmentPredecessor(ctx, query, head.Draft)
		if err != nil || basis.predecessor.Digest == "" {
			return basis, err
		}
		basis.roleTarget = head.Draft.ResourceChange.RolesEdit.Change.TargetProfile
		basis.excluded = map[string]bool{}
		return basis, nil
	}
	successor.PolicyAnchored = true
	recipients, err := successor.rotationRecipients(channel, LiveEpoch)
	if err != nil {
		return nil, err
	}
	evidence, err := livePersonalDenyEvidence(ctx, query, successor, head,
		RotationTask{EpochRecord: epoch.Record, Recipients: recipients}, epoch.Principal, previousTree)
	if err != nil || evidence == nil {
		return basis, err
	}
	digest, err := livePersonalDenyTransitionDigest(epoch.Record, *evidence)
	if err != nil || digest != epoch.Record.LiveTransitionDigest {
		return basis, err
	}
	basis.previous, basis.predecessor, err = readPrecedingPolicyState(ctx, query, head.Draft)
	if err != nil {
		return nil, err
	}
	basis.excluded = map[string]bool{evidence.TargetProfileID: true}
	return basis, nil
}

func (basis *liveMessageAuthorBasis) previousAuthorDisclosure(author Principal, previousTree *textChannelPolicyTreeCache) (*TextChannelPolicyDisclosure, error) {
	channel, prior, successor := basis.epoch.ChannelID, basis.previous, basis.successor
	if basis.excluded == nil || basis.excluded[author.ProfileID] || !retainedPersonalDenyReader(prior, successor, basis.epoch, author) {
		return nil, nil
	}
	proof, err := textChannelDisclosure(prior, basis.predecessor, channel, author.DeviceID, previousTree, 0)
	if err != nil || proof == nil || proof.Recipient == nil || proof.Recipient.Statement.CanSend == nil ||
		(author.ProfileID != basis.roleTarget && !*proof.Recipient.Statement.CanSend) {
		return nil, err
	}
	return proof, nil
}
