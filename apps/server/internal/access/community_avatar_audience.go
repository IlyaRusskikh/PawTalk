package access

import (
	"context"
	"database/sql"
	"encoding/hex"
	"slices"
)

const communityAvatarAudiencePageSize = 16

type CommunityAvatarAudienceBasis struct {
	Root      string                 `json:"root"`
	Invites   string                 `json:"invites"`
	Catalogue string                 `json:"catalogue"`
	Rosters   string                 `json:"rosters"`
	Inclusion ChannelPolicyInclusion `json:"inclusion"`
}

type CommunityAvatarRecipientProof struct {
	ID      string                    `json:"id"`
	Kind    string                    `json:"kind"`
	Profile ProfileRankProof          `json:"profile"`
	Parts   ProfileRoleAuthorityParts `json:"parts"`
	Key     *profileSigningKeyOpening `json:"key"`
}

type CommunityAvatarAudience struct {
	Revision   int64                           `json:"policyRevision"`
	Head       string                          `json:"policyHead"`
	Basis      CommunityAvatarAudienceBasis    `json:"basis"`
	Recipients []CommunityAvatarRecipientProof `json:"recipients"`
	Next       string                          `json:"next,omitempty"`
}

type CommunityAvatarPublisher struct {
	Basis     CommunityAvatarAudienceBasis  `json:"basis"`
	Device    CommunityAvatarRecipientProof `json:"device"`
	Grants    []string                      `json:"grants"`
	GrantSalt string                        `json:"grantsSalt"`
}

func communityAvatarRecipientIDs(state State) []string {
	var recipients []string
	for id, key := range state.KeyRecipients {
		if state.canReceiveCommunityAvatar(id, key) {
			recipients = append(recipients, id)
		}
	}
	slices.Sort(recipients)
	return recipients
}

func (s State) canReceiveCommunityAvatar(id string, key KeyRecipient) bool {
	if key.Kind == "recovery" {
		identity := s.RecoveryIdentities[key.ProfileID]
		return s.Members[key.ProfileID].Active && s.ProfileBindings[key.ProfileID] == "" &&
			identity.ID == id && identity.AgreementKey == key.PublicKey
	}
	return s.canReadCommunityAvatar(Principal{ProfileID: key.ProfileID, DeviceID: id})
}

type communityAvatarProofBuilder struct {
	state State
	seed  [32]byte
	tree  *channelPolicyTree
	keys  map[string][]ProfileRoleKey
	basis CommunityAvatarAudienceBasis
}

func prepareCommunityAvatarProof(state State, head PolicyProof) (communityAvatarProofBuilder, error) {
	var result communityAvatarProofBuilder
	if head.Draft.TextProjectionVersion != ProfileRoleAuthorityProjectionVersion {
		return result, ErrPolicyAttestationUnavailable
	}
	seed := head.Draft.TextProjectionSeed
	if !isDigest(seed) {
		return result, ErrPolicyConflict
	}
	_, _ = hex.Decode(result.seed[:], []byte(seed))
	tree, err := state.textProjectionTree(seed, head.Draft.TextProjectionVersion)
	if err != nil {
		return result, err
	}
	if tree.root() != head.Draft.TextProjectionRoot {
		return result, ErrPolicyConflict
	}
	inclusion, err := tree.proof(profileRankProjectionID)
	if err != nil {
		return result, err
	}
	invites, err := tree.inviteAdmission.digest()
	if err != nil {
		return result, err
	}
	result.state, result.tree, result.keys = state, tree, scopedRoleKeys(state)
	result.basis = CommunityAvatarAudienceBasis{Root: tree.ranks.digest, Invites: invites,
		Catalogue: tree.inviteAdmission.Catalogue, Rosters: tree.inviteAdmission.Rosters, Inclusion: inclusion}
	return result, nil
}

func (b communityAvatarProofBuilder) deviceKey(actor Principal, kind string) (CommunityAvatarRecipientProof, error) {
	var result CommunityAvatarRecipientProof
	profile, err := b.tree.ranks.proof(actor.ProfileID)
	if err != nil {
		return result, err
	}
	opening := b.state.profileRoleAuthority(b.seed, b.state.Members[actor.ProfileID], b.keys[actor.ProfileID])
	parts, err := opening.parts()
	if err != nil {
		return result, err
	}
	_, key, err := opening.keyTreeFor(kind, actor.DeviceID)
	if err != nil {
		return result, err
	}
	if key == nil {
		return result, ErrPolicyConflict
	}
	return CommunityAvatarRecipientProof{ID: actor.DeviceID, Kind: kind, Profile: profile, Parts: parts, Key: key}, nil
}

func readCommunityAvatarPublisher(ctx context.Context, query SessionQuery, content CommunityAvatarContent) (CommunityAvatarPublisher, error) {
	state, head, err := readInviteBatchPolicy(ctx, query, content.PolicyRevision)
	if err != nil {
		return CommunityAvatarPublisher{}, err
	}
	binding := content.Context
	actor := Principal{ProfileID: binding.ProfileID, DeviceID: binding.DeviceID}
	if head.Digest != binding.PolicyHead || !state.canReadCommunityAvatar(actor) {
		return CommunityAvatarPublisher{}, ErrPolicyConflict
	}
	if binding.Scope != "profile" && state.CheckGrant(state.Members[actor.ProfileID], Scope{}, editCommunity, 0) != Allowed {
		return CommunityAvatarPublisher{}, ErrPolicyConflict
	}
	proof, err := prepareCommunityAvatarProof(state, head)
	if err != nil {
		return CommunityAvatarPublisher{}, err
	}
	device, err := proof.deviceKey(actor, "signing")
	if err != nil {
		return CommunityAvatarPublisher{}, err
	}
	opening := state.profileRoleAuthority(proof.seed, state.Members[actor.ProfileID], proof.keys[actor.ProfileID])
	return CommunityAvatarPublisher{Basis: proof.basis, Device: device, Grants: opening.Grants, GrantSalt: opening.GrantsSalt}, nil
}

func (s *Store) DispatchCommunityAvatarAudience(ctx context.Context, resolve ResolveSession, after string,
	deliver func(CommunityAvatarAudience) error) error {
	return s.dispatchAvatarAudience(ctx, resolve, after, false, "", deliver)
}

func (s *Store) DispatchProfileAvatarAudience(ctx context.Context, resolve ResolveSession, after, sharing string,
	deliver func(CommunityAvatarAudience) error) error {
	return s.dispatchAvatarAudience(ctx, resolve, after, true, sharing, deliver)
}

func (s *Store) dispatchAvatarAudience(ctx context.Context, resolve ResolveSession, after string, ownProfile bool, sharing string,
	deliver func(CommunityAvatarAudience) error) error {
	if after != "" && !isDigest(after) {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canReadCommunityAvatar(actor) {
			return ChannelRestricted
		}
		if !ownProfile {
			if allowed := state.CheckGrant(state.Members[actor.ProfileID], Scope{}, editCommunity, s.now().UnixMilli()); allowed != Allowed {
				return allowed
			}
		}
		head, err := readPolicyHead(ctx, conn)
		if err != nil {
			return err
		}
		proof, err := prepareCommunityAvatarProof(state, head)
		if err != nil {
			return err
		}
		ids := communityAvatarRecipientIDs(state)
		if ownProfile {
			ids = profileAvatarRecipients(state, actor.ProfileID, sharing)
		}
		start, found := slices.BinarySearch(ids, after)
		if after != "" && !found {
			return ErrPolicyConflict
		}
		if found {
			start++
		}
		end := min(start+communityAvatarAudiencePageSize, len(ids))
		page := CommunityAvatarAudience{Revision: head.Draft.Revision, Head: head.Digest, Basis: proof.basis,
			Recipients: make([]CommunityAvatarRecipientProof, 0, end-start)}
		for _, id := range ids[start:end] {
			key := state.KeyRecipients[id]
			recipient, err := proof.deviceKey(Principal{ProfileID: key.ProfileID, DeviceID: id}, key.Kind)
			if err != nil {
				return err
			}
			page.Recipients = append(page.Recipients, recipient)
		}
		if end < len(ids) {
			page.Next = ids[end-1]
		}
		return deliver(page)
	})
}
