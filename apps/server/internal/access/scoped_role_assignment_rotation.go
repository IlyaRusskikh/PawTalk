package access

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"maps"
	"slices"
	"strconv"
)

type scopedRoleProfileWitness struct {
	Proof    ProfileRankProof  `json:"proof"`
	Opening  map[string]any    `json:"opening"`
	Unopened map[string]string `json:"unopened,omitempty"`
}

type scopedRoleChannelWitness struct {
	Roles    map[string]ScopedChannelRuleOpening `json:"roles"`
	Personal ScopedChannelRuleOpening            `json:"personal"`
}

type scopedRoleAssignmentWitness struct {
	Auxiliary   scopedRoleAuxiliaryWitness             `json:"auxiliary"`
	Actor       scopedRoleProfileWitness               `json:"actor"`
	ActorKey    *profileSigningKeyOpening              `json:"actorKey"`
	Target      scopedRoleProfileWitness               `json:"target"`
	Definitions map[string]ScopedRoleDefinitionOpening `json:"definitions"`
	Channel     scopedRoleChannelAssignmentWitness     `json:"channel"`
	Roster      *scopedRoleRosterOpening               `json:"roster,omitempty"`
}

type scopedRoleAuxiliaryWitness struct {
	Root      string                 `json:"root"`
	Invites   string                 `json:"invites"`
	Catalogue string                 `json:"catalogue"`
	Rosters   string                 `json:"rosters"`
	Inclusion ChannelPolicyInclusion `json:"inclusion"`
}

type scopedRoleChannelAssignmentWitness struct {
	Basis  ScopedChannelRuleBasis   `json:"basis"`
	Actor  scopedRoleChannelWitness `json:"actor"`
	Before scopedRoleChannelWitness `json:"before"`
	After  scopedRoleChannelWitness `json:"after"`
}

type ScopedRoleAssignmentRotationEvidence struct {
	Record             PolicyProof                       `json:"record"`
	Assignment         scopedRoleAssignmentWitness       `json:"assignment"`
	PreviousTextPolicy *TextChannelPolicyDisclosure      `json:"previousTextPolicy"`
	PreviousOpenings   map[string]RotationProfileOpening `json:"previousOpenings"`
	RemovedGroup       *LivePersonalDenyRemovedGroup     `json:"removedGroup,omitempty"`
}

func scopedRoleAssignmentEpochDigest(epoch EpochRecord, proof PolicyProof) (string, error) {
	draft := proof.Draft
	change := draft.ResourceChange
	if (epoch.Purpose != LiveEpoch && epoch.Purpose != ArchiveEpoch) || draft.Action != EditScopedRoles ||
		change == nil || change.RolesEdit == nil || epoch.Revision != draft.Revision || epoch.PolicyDigest != draft.ResultDigest ||
		!isDigest(proof.Digest) || !isDigest(draft.PreviousDigest) || !isDigest(draft.TextProjectionRoot) {
		return "", InvalidAction
	}
	frame, err := SignatureFrame("pawtalk-protected-"+epoch.Purpose+"-role-assignment-v1", epoch.ChannelID,
		strconv.FormatInt(draft.Revision, 10), draft.PreviousDigest, proof.Digest, draft.ResultDigest, draft.TextProjectionRoot,
		draft.OperationID, proof.Principal.ProfileID, proof.Principal.DeviceID, change.RolesEdit.EditorProof)
	if err != nil {
		return "", err
	}
	return hexHash(frame), nil
}

func scopedRoleAssignmentRotationEvidence(ctx context.Context, query SessionQuery, current State, head PolicyProof, task RotationTask,
	claimant Principal, history *textChannelPolicyTreeCache) (*ScopedRoleAssignmentRotationEvidence, error) {
	draft := head.Draft
	if draft.Action != EditScopedRoles || draft.TextProjectionVersion != ProfileRoleAuthorityProjectionVersion ||
		draft.Revision != task.Revision || draft.ResultDigest != task.PolicyDigest {
		return nil, nil
	}
	previous, predecessor, err := readAttestedRoleAssignmentPredecessor(ctx, query, draft)
	if err != nil || predecessor.Digest == "" {
		return nil, err
	}
	return buildScopedRoleAssignmentRotationEvidence(previous, current, predecessor, head, task, claimant, history)
}

func readAttestedRoleAssignmentPredecessor(ctx context.Context, query SessionQuery, draft PolicyDraft) (State, PolicyProof, error) {
	previous, predecessor, err := readPrecedingPolicyState(ctx, query, draft)
	if errors.Is(err, sql.ErrNoRows) {
		return State{}, PolicyProof{}, nil
	}
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	if predecessor.Draft.TextProjectionVersion != ProfileRoleAuthorityProjectionVersion {
		return State{}, PolicyProof{}, nil
	}
	var attested bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM protected_policy_attestations WHERE revision=?
		UNION ALL SELECT 1 FROM protected_policy_attestations_v2 WHERE revision=?
	)`, predecessor.Draft.Revision, predecessor.Draft.Revision).Scan(&attested); err != nil || !attested {
		return State{}, PolicyProof{}, err
	}
	return previous, predecessor, nil
}

func buildScopedRoleAssignmentRotationEvidence(previous, current State, predecessor, head PolicyProof, task RotationTask,
	claimant Principal, history *textChannelPolicyTreeCache) (*ScopedRoleAssignmentRotationEvidence, error) {
	channel, purpose := task.ChannelID, task.Purpose
	resource := head.Draft.ResourceChange
	if resource == nil || resource.RolesEdit == nil || !retainedPersonalDenyReader(previous, current, task.EpochRecord, claimant) {
		return nil, nil
	}
	change := resource.RolesEdit.Change
	if change.TargetProfile == "" || validateScopedRoleRosterCommitment(predecessor, change) != nil ||
		!previous.CanDeliver(head.Principal.ProfileID, channel, 0) || !current.CanDeliver(head.Principal.ProfileID, channel, 0) ||
		!previous.CanDeliver(change.TargetProfile, channel, 0) && !current.CanDeliver(change.TargetProfile, channel, 0) {
		return nil, nil
	}
	update, err := previous.scopedRoleUpdate(head.Principal, change)
	if err != nil || !maps.Equal(grantSet(update.Assignments[change.TargetProfile]), grantSet(current.Members[change.TargetProfile].Roles)) {
		return nil, nil
	}
	oldRecipients, err := previous.rotationRecipients(channel, purpose)
	if err != nil {
		return nil, err
	}
	newRecipients, err := current.rotationRecipients(channel, purpose)
	if err != nil {
		return nil, err
	}
	if !maps.Equal(newRecipients, task.Recipients) {
		return nil, ErrPolicyConflict
	}
	var seed [32]byte
	if _, err := hex.Decode(seed[:], []byte(predecessor.Draft.TextProjectionSeed)); err != nil {
		return nil, ErrPolicyConflict
	}
	target := change.TargetProfile
	removed := make(map[string]KeyRecipient)
	keepsTarget := current.CanDeliver(target, channel, 0) && (purpose == LiveEpoch ||
		current.CheckGrant(current.Members[target], current.scope(current.Channels[channel]), "history.full", 0) == Allowed)
	if !keepsTarget {
		for id, key := range oldRecipients {
			if key.ProfileID == target {
				removed[id] = key
				delete(oldRecipients, id)
			}
		}
	}
	var removedGroup *LivePersonalDenyRemovedGroup
	if len(removed) != 0 {
		opening := textRotationProfileOpening(seed, channel, purpose, target)
		digest, err := textRotationDigest(removed, opening.ContentSalt)
		if err != nil {
			return nil, err
		}
		removedGroup = &LivePersonalDenyRemovedGroup{Salt: opening.Salt, Digest: digest}
	}
	witness, err := previous.scopedRoleAssignmentWitness(predecessor, head, channel, seed, history, keepsTarget)
	if err != nil {
		return nil, err
	}
	text, err := textChannelDisclosure(previous, predecessor, channel, claimant.DeviceID, history, 0)
	if err != nil {
		return nil, err
	}
	return &ScopedRoleAssignmentRotationEvidence{Record: scopedRoleAssignmentRecord(head),
		Assignment: witness, PreviousTextPolicy: text, RemovedGroup: removedGroup,
		PreviousOpenings: rotationProfileOpenings(oldRecipients, seed, channel, purpose)}, nil
}

func scopedRoleAssignmentRecord(head PolicyProof) PolicyProof {
	draft := head.Draft
	// The client verifies the device-signed intent. This disclosure carries
	// neither the successor's projection seed nor the global policy signature.
	resource := *draft.ResourceChange
	edit := *resource.RolesEdit
	if edit.Change.RosterCommitment != "" {
		edit.Change.RosterChannel = ""
	}
	resource.RolesEdit = &edit
	clean := PolicyDraft{Action: draft.Action, OperationID: draft.OperationID, Revision: draft.Revision,
		PreviousDigest: draft.PreviousDigest, ResultDigest: draft.ResultDigest, ResourceChange: &resource,
		TextProjectionRoot: draft.TextProjectionRoot}
	return PolicyProof{Principal: head.Principal, Draft: clean, Digest: head.Digest}
}

func (s State) scopedRoleAssignmentWitness(predecessor, head PolicyProof, channel string, seed [32]byte,
	history *textChannelPolicyTreeCache, openTargetKeys bool) (scopedRoleAssignmentWitness, error) {
	var witness scopedRoleAssignmentWitness
	policy, err := history.treeFor(s, predecessor)
	if err != nil {
		return witness, err
	}
	invites, err := policy.inviteAdmission.digest()
	if err != nil {
		return witness, err
	}
	inclusion, err := policy.proof(profileRankProjectionID)
	if err != nil {
		return witness, err
	}
	witness.Auxiliary = scopedRoleAuxiliaryWitness{Root: policy.ranks.digest, Invites: invites, Catalogue: policy.roleCatalogue.digest(),
		Rosters: policy.roleRosters.commitment.digest, Inclusion: inclusion}
	change := head.Draft.ResourceChange.RolesEdit.Change
	actor, target := s.Members[head.Principal.ProfileID], s.Members[change.TargetProfile]
	if change.RosterCommitment != "" {
		witness.Roster, err = policy.roleRosters.opening(change.RosterCommitment, actor.ID, target.ID)
		if err != nil {
			return witness, err
		}
	}
	keys := scopedRoleKeys(s)
	openProfile := func(subject Subject, openKeys, openRecovery bool) (scopedRoleProfileWitness, error) {
		proof, err := policy.ranks.proof(subject.ID)
		if err != nil {
			return scopedRoleProfileWitness{}, err
		}
		opening := s.profileRoleAuthority(seed, subject, keys[subject.ID])
		result := scopedRoleProfileWitness{Proof: proof, Opening: map[string]any{"roles": opening.Roles, "rolesSalt": opening.RolesSalt,
			"grants": opening.Grants, "grantsSalt": opening.GrantsSalt}}
		if !openKeys || !openRecovery {
			parts, err := opening.parts()
			if err != nil {
				return scopedRoleProfileWitness{}, err
			}
			result.Unopened = make(map[string]string)
			if !openKeys {
				result.Unopened["keys"] = parts.Keys
			}
			if !openRecovery {
				result.Unopened["recoveryReady"] = parts.RecoveryReady
			}
		}
		if openKeys {
			result.Opening["keys"], result.Opening["keysSalt"] = opening.Keys, opening.KeysSalt
		}
		if openRecovery {
			result.Opening["recoveryReady"], result.Opening["recoverySalt"] = opening.RecoveryReady, opening.RecoverySalt
		}
		return result, nil
	}
	witness.Actor, err = openProfile(actor, false, false)
	if err != nil {
		return witness, err
	}
	actorAuthority := s.profileRoleAuthority(seed, actor, keys[actor.ID])
	_, witness.ActorKey, err = actorAuthority.keyTree(head.Principal.DeviceID)
	if err != nil {
		return witness, err
	}
	if witness.ActorKey == nil {
		return witness, ErrPolicyConflict
	}
	needsRecovery := !s.baseGrant(target, Administrator) && slices.ContainsFunc(change.Add,
		func(role string) bool { return slices.Contains(s.Roles[role].Grants, Administrator) })
	witness.Target, err = openProfile(target, openTargetKeys, needsRecovery)
	if err != nil {
		return witness, err
	}
	basis, rules, err := s.scopedChannelRuleBasis(channel, seed, policy)
	if err != nil {
		return witness, err
	}
	witness.Channel.Basis = basis
	openRules := func(subject Subject, roleIDs []string) (scopedRoleChannelWitness, error) {
		result := scopedRoleChannelWitness{Roles: make(map[string]ScopedChannelRuleOpening)}
		for _, id := range append([]string{Everyone}, roleIDs...) {
			proof, err := rules.opening("role", id)
			if err != nil {
				return result, err
			}
			result.Roles[id] = proof
		}
		var err error
		result.Personal, err = rules.opening("profile", subject.ID)
		return result, err
	}
	witness.Channel.Actor, err = openRules(actor, actor.Roles)
	if err != nil {
		return witness, err
	}
	witness.Channel.Before, err = openRules(target, target.Roles)
	if err != nil {
		return witness, err
	}
	nextRoles := slices.DeleteFunc(slices.Clone(target.Roles), func(role string) bool { return slices.Contains(change.Remove, role) })
	witness.Channel.After, err = openRules(target, append(nextRoles, change.Add...))
	if err != nil {
		return witness, err
	}
	witness.Definitions = make(map[string]ScopedRoleDefinitionOpening)
	for id := range grantSet(append(append([]string{Everyone}, target.Roles...), change.Add...)) {
		witness.Definitions[id], err = policy.roleCatalogue.opening(id)
		if err != nil {
			return witness, err
		}
	}
	return witness, nil
}
