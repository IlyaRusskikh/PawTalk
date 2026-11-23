package access

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"reflect"
	"slices"
)

const (
	LinkPolicyProfiles  = "profile.link"
	UnlinkPolicyProfile = "profile.unlink"
)

var ErrProfileLinkExpired = errors.New("protected profile link expired")

func isProfileLinkingAction(action string) bool {
	return action == LinkPolicyProfiles || action == UnlinkPolicyProfile
}

func (s *State) applyProfileLinking(actor Principal, action string, change *PolicyResourceChange) error {
	if change == nil {
		return InvalidAction
	}
	switch action {
	case LinkPolicyProfiles:
		if change.ProfileLink == nil || *change != (PolicyResourceChange{ID: actor.ProfileID, ProfileLink: change.ProfileLink}) {
			return InvalidAction
		}
		return s.applyProfileLink(actor, *change.ProfileLink)
	case UnlinkPolicyProfile:
		if change.ProfileUnlink == nil || *change != (PolicyResourceChange{ID: change.ID, ProfileUnlink: change.ProfileUnlink}) {
			return InvalidAction
		}
		return s.applyProfileUnlink(actor, change.ID, *change.ProfileUnlink)
	default:
		return InvalidAction
	}
}

func (s *State) revokeProfileLinkEpochWindows(recipients map[string]map[string]bool, changes map[string]bool, now int64,
	actor Principal, action string, resource *PolicyResourceChange) {
	for channel, readers := range recipients {
		_, primaryReads := readers[actor.ProfileID]
		secondaryReads := false
		if action == LinkPolicyProfiles {
			_, secondaryReads = readers[resource.ProfileLink.SecondaryProfileID]
		}
		if primaryReads || secondaryReads {
			changes[channel] = true
			if window, exists := s.EpochWindows[channel]; exists {
				s.EpochWindows[channel] = window.Revoke(now)
			}
		}
	}
}

// The server binds both active devices to the same preview revision and chosen
// primary before it commits the verified operation. At is the server's signed
// commit time, retained only to replay ban decisions deterministically.
type ProfilePolicyLink struct {
	SecondaryProfileID string
	PrimaryDeviceID    string
	SecondaryDeviceID  string
	CutoverDigest      string
	ServerKey          string
	ExpiresAt          int64
	At                 int64
	PrimaryProof       string
	SecondaryProof     string
}

type ProfilePolicyUnlink struct {
	CutoverDigest     string
	ServerKey         string
	ExpiresAt         int64
	At                int64
	DeviceProof       string
	GrantDeviceRebind bool `json:",omitempty"`
}

type ProfileLinkPreview struct {
	PrimaryProfileID   string   `json:"primaryProfileId"`
	SecondaryProfileID string   `json:"secondaryProfileId"`
	PrimaryRoles       []string `json:"primaryRoles"`
	SecondaryRoles     []string `json:"secondaryRoles"`
	MovedDevices       int      `json:"movedDevices"`
	PolicyHead         string   `json:"policyHead"`
	PolicyRevision     int64    `json:"policyRevision"`
}

type ProfileLinkStatus struct {
	ProfileID  string   `json:"profileId"`
	PolicyHead string   `json:"policyHead"`
	Sources    []string `json:"sources"`
}

func (s *Store) ReadProfileLinkStatus(ctx context.Context, resolve ResolveSession) (ProfileLinkStatus, error) {
	var status ProfileLinkStatus
	err := s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		status = ProfileLinkStatus{ProfileID: actor.ProfileID, PolicyHead: head.Digest, Sources: state.ProfileGroup(actor.ProfileID)[1:]}
		return nil
	})
	return status, err
}

type SyncProfileLinkingRuntime func(context.Context, *sql.Tx, Principal, PolicyDraft) error

type ProfileLinkingBasis struct {
	PrimaryDevice   PolicyDevice
	SecondaryDevice PolicyDevice
	PrimaryGroup    []string
	SecondaryGroup  []string
	AffectedDevices []string
	Owner           string
}

// ReadProfileLinkingBasis resolves consent keys and restrictions against the
// exact preceding signed policy, including during historical verification.
func ReadProfileLinkingBasis(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) (ProfileLinkingBasis, error) {
	var basis ProfileLinkingBasis
	if !isProfileLinkingAction(draft.Action) || draft.ResourceChange == nil {
		return basis, InvalidAction
	}
	if draft.Revision == 0 {
		head, err := readPolicyHead(ctx, query)
		if err != nil {
			return basis, err
		}
		if draft.PreviousDigest != head.Digest {
			return basis, ErrPolicyConflict
		}
		draft.Revision = head.Draft.Revision + 1
	}
	state, _, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return basis, err
	}
	basis.PrimaryDevice, basis.PrimaryGroup = state.PolicyDevices[actor.DeviceID], state.ProfileGroup(actor.ProfileID)
	basis.Owner = state.Owner
	if draft.Action == LinkPolicyProfiles && draft.ResourceChange.ProfileLink != nil {
		claim := draft.ResourceChange.ProfileLink
		basis.SecondaryDevice = state.PolicyDevices[claim.SecondaryDeviceID]
		basis.SecondaryGroup = state.ProfileGroup(claim.SecondaryProfileID)
		for id, device := range state.PolicyDevices {
			if device.ProfileID == claim.SecondaryProfileID && !device.Revoked {
				basis.AffectedDevices = append(basis.AffectedDevices, id)
			}
		}
	} else if draft.Action == UnlinkPolicyProfile {
		for id, origin := range state.ProfileDeviceOrigins {
			if origin == draft.ResourceChange.ID {
				basis.AffectedDevices = append(basis.AffectedDevices, id)
			}
		}
	}
	slices.Sort(basis.AffectedDevices)
	if err := state.applyProfileLinking(actor, draft.Action, draft.ResourceChange); err != nil {
		return ProfileLinkingBasis{}, err
	}
	return basis, nil
}

// CommitProfileLinking uses the policy predecessor seen by both consenting
// devices. The protocol verifier and runtime session update run in one transaction.
func (s *Store) CommitProfileLinking(ctx context.Context, resolve ResolveSession, input PolicyDraft, verifyIntent VerifyPolicyDraft,
	sign SignServerPolicyDraft, verify VerifyPolicyDraft, syncRuntime SyncProfileLinkingRuntime) (PolicyProof, error) {
	if !isProfileLinkingAction(input.Action) || !validRecoveryIntentFields(input) || resolve == nil ||
		verifyIntent == nil || sign == nil || verify == nil || syncRuntime == nil {
		return PolicyProof{}, InvalidAction
	}
	unsigned, err := profileLinkingClaim(input.Action, input.ResourceChange, 0)
	if err != nil {
		return PolicyProof{}, err
	}
	if !reflect.DeepEqual(unsigned, *input.ResourceChange) {
		return PolicyProof{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	prior, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE operation_id=?`, input.OperationID))
	if err == nil {
		if prior.Principal != actor || prior.Draft.Action != input.Action || prior.Draft.PreviousDigest != input.PreviousDigest {
			return PolicyProof{}, ErrPolicyConflict
		}
		stored, err := profileLinkingClaim(prior.Draft.Action, prior.Draft.ResourceChange, 0)
		if err != nil || !reflect.DeepEqual(stored, *input.ResourceChange) {
			return PolicyProof{}, ErrPolicyConflict
		}
		return prior, verify(ctx, tx, actor, prior.Draft)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return PolicyProof{}, err
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	if head.Digest != input.PreviousDigest {
		return PolicyProof{}, ErrPolicyConflict
	}
	if err := verify(ctx, tx, head.Principal, head.Draft); err != nil {
		return PolicyProof{}, err
	}
	resource, err := profileLinkingClaim(input.Action, input.ResourceChange, s.now().UnixMilli())
	if err != nil {
		return PolicyProof{}, err
	}
	input.ResourceChange = &resource
	if err := verifyIntent(ctx, tx, actor, input); err != nil {
		return PolicyProof{}, err
	}
	input.TextProjectionVersion = head.Draft.TextProjectionVersion
	if head.Draft.TextProjectionSeed != "" {
		var seed [32]byte
		if _, err := rand.Read(seed[:]); err != nil {
			return PolicyProof{}, err
		}
		input.TextProjectionSeed = hex.EncodeToString(seed[:])
	}
	draft, err := preparePolicyDraft(&state, revision, head, actor, input)
	if err != nil {
		return PolicyProof{}, err
	}
	if draft.Signature, err = sign(ctx, tx, actor, draft); err != nil {
		return PolicyProof{}, err
	}
	proof, err := s.commitPolicyInTransaction(ctx, tx, actor, verify, draft, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	if err := syncRuntime(ctx, tx, actor, draft); err != nil {
		return PolicyProof{}, err
	}
	if _, err := profileLinkingClaim(input.Action, input.ResourceChange, s.now().UnixMilli()); err != nil {
		return PolicyProof{}, err
	}
	if err := tx.Commit(); err != nil {
		return PolicyProof{}, err
	}
	return proof, nil
}

func profileLinkingClaim(action string, input *PolicyResourceChange, at int64) (PolicyResourceChange, error) {
	if input == nil {
		return PolicyResourceChange{}, InvalidAction
	}
	switch action {
	case LinkPolicyProfiles:
		if input.ProfileLink != nil && *input == (PolicyResourceChange{ID: input.ID, ProfileLink: input.ProfileLink}) {
			claim := *input.ProfileLink
			if at != 0 && !validProfileLinkTime(at, claim.ExpiresAt) {
				return PolicyResourceChange{}, ErrProfileLinkExpired
			}
			claim.At = at
			return PolicyResourceChange{ID: input.ID, ProfileLink: &claim}, nil
		}
	case UnlinkPolicyProfile:
		if input.ProfileUnlink != nil && *input == (PolicyResourceChange{ID: input.ID, ProfileUnlink: input.ProfileUnlink}) {
			claim := *input.ProfileUnlink
			if at != 0 && !validProfileLinkTime(at, claim.ExpiresAt) {
				return PolicyResourceChange{}, ErrProfileLinkExpired
			}
			claim.At = at
			return PolicyResourceChange{ID: input.ID, ProfileUnlink: &claim}, nil
		}
	}
	return PolicyResourceChange{}, InvalidAction
}

func (s State) validProfileBindings() bool {
	for secondary, primary := range s.ProfileBindings {
		if !isDigest(secondary) || !isDigest(primary) || primary == secondary || secondary == s.Owner ||
			s.ProfileBindings[primary] != "" || s.Members[primary].ID != primary ||
			s.Members[secondary].ID != secondary || s.Members[secondary].Active || len(s.Members[secondary].Roles) != 0 {
			return false
		}
	}
	for device, origin := range s.ProfileDeviceOrigins {
		primary := s.ProfileBindings[origin]
		if primary == "" || s.PolicyDevices[device].ProfileID != primary || !isDigest(device) {
			return false
		}
	}
	return true
}

func (s State) profileGroupBan(profile string, at int64) error {
	if removal := s.MemberRemovals[profile]; removal.BannedAt(at) {
		return MemberBanError{removal}
	}
	for source, primary := range s.ProfileBindings {
		if primary != profile {
			continue
		}
		if removal := s.MemberRemovals[source]; removal.BannedAt(at) {
			return MemberBanError{removal}
		}
	}
	return nil
}

func (s State) checkProfileLink(primary, secondary Principal, at int64) error {
	if !isDigest(primary.ProfileID) || !isDigest(secondary.ProfileID) || primary.ProfileID == secondary.ProfileID ||
		!isDigest(primary.DeviceID) || !isDigest(secondary.DeviceID) || primary.DeviceID == secondary.DeviceID {
		return InvalidAction
	}
	if secondary.ProfileID == s.Owner {
		return HierarchyDenied
	}
	for _, actor := range []Principal{primary, secondary} {
		if err := s.profileGroupBan(actor.ProfileID, at); err != nil {
			return err
		}
		if !s.PolicyAnchored || !s.Members[actor.ProfileID].Active || !s.hasPolicyDevice(actor) || s.ProfileBindings[actor.ProfileID] != "" {
			return Inactive
		}
	}
	return nil
}

// PreviewProfileLink has no policy or credential side effects. It exposes
// only the groups whose trusted devices are already confirmed by the caller.
type VerifyProfileLinkCounterpart func(context.Context, SessionQuery, Principal, Principal) error

func (s *Store) PreviewProfileLink(ctx context.Context, resolve ResolveSession, counterpart Principal, primaryID string,
	verifyCounterpart VerifyProfileLinkCounterpart) (ProfileLinkPreview, error) {
	var preview ProfileLinkPreview
	if resolve == nil || verifyCounterpart == nil {
		return preview, InvalidAction
	}
	err := s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if err := verifyCounterpart(ctx, conn, actor, counterpart); err != nil {
			return err
		}
		primary, secondary := actor, counterpart
		if primaryID == counterpart.ProfileID {
			primary, secondary = counterpart, actor
		} else if primaryID != actor.ProfileID {
			return InvalidAction
		}
		if err := state.checkProfileLink(primary, secondary, s.now().UnixMilli()); err != nil {
			return err
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		roleNames := func(profile string) []string {
			roles := state.Members[profile].Roles
			names := make([]string, 0, len(roles))
			for _, role := range roles {
				name := state.RolePresentation[role].Name
				if name == "" {
					name = role
				}
				names = append(names, name)
			}
			return names
		}
		preview = ProfileLinkPreview{PrimaryProfileID: primary.ProfileID, SecondaryProfileID: secondary.ProfileID,
			PrimaryRoles: roleNames(primary.ProfileID), SecondaryRoles: roleNames(secondary.ProfileID),
			PolicyHead: head.Digest, PolicyRevision: head.Draft.Revision}
		for _, device := range state.PolicyDevices {
			if device.ProfileID == secondary.ProfileID && !device.Revoked {
				preview.MovedDevices++
			}
		}
		return nil
	})
	return preview, err
}

func validProfileLinkTime(at, expiresAt int64) bool {
	return at > 0 && expiresAt > at && expiresAt <= maxInviteDate
}

func (s *State) applyProfileLink(actor Principal, link ProfilePolicyLink) error {
	secondary := Principal{ProfileID: link.SecondaryProfileID, DeviceID: link.SecondaryDeviceID}
	if actor.DeviceID != link.PrimaryDeviceID || !isDigest(link.CutoverDigest) || !validRecoveryProof(link.ServerKey, 32) ||
		!validProfileLinkTime(link.At, link.ExpiresAt) || !validRecoveryProof(link.PrimaryProof, 64) || !validRecoveryProof(link.SecondaryProof, 64) {
		return InvalidAction
	}
	if err := s.checkProfileLink(actor, secondary, link.At); err != nil {
		return err
	}
	primaryID, secondaryID := actor.ProfileID, secondary.ProfileID
	if s.ProfileBindings == nil {
		s.ProfileBindings = make(map[string]string)
	}
	if s.ProfileDeviceOrigins == nil {
		s.ProfileDeviceOrigins = make(map[string]string)
	}
	for origin, effective := range s.ProfileBindings {
		if effective == secondaryID {
			s.ProfileBindings[origin] = primaryID
		}
	}
	s.ProfileBindings[secondaryID] = primaryID
	for id, device := range s.PolicyDevices {
		if device.ProfileID != secondaryID {
			continue
		}
		if s.ProfileDeviceOrigins[id] == "" {
			s.ProfileDeviceOrigins[id] = secondaryID
		}
		device.ProfileID = primaryID
		s.PolicyDevices[id] = device
		if recipient, ok := s.KeyRecipients[id]; ok && recipient.Kind == "device" {
			recipient.ProfileID = primaryID
			s.KeyRecipients[id] = recipient
		}
	}
	s.retireRecoveryIdentity(secondaryID)
	s.Members[secondaryID] = Subject{ID: secondaryID, TimeoutUntil: s.Members[secondaryID].TimeoutUntil}
	s.clearProfileLinkGrants(secondaryID)
	s.refreshAdmissions()
	return nil
}

func (s *State) clearProfileLinkGrants(profile string) {
	clearGrants := func(acl ACL) {
		if overwrite, ok := acl.Profiles[profile]; ok {
			if len(overwrite.Deny) == 0 {
				delete(acl.Profiles, profile)
			} else {
				overwrite.Allow = nil
				acl.Profiles[profile] = overwrite
			}
		}
	}
	for _, category := range s.Categories {
		clearGrants(category)
	}
	for _, channel := range s.Channels {
		clearGrants(channel.ACL)
	}
	for category, creator := range s.CategoryCreators {
		if creator == profile {
			delete(s.CategoryCreators, category)
		}
	}
}

func (s *State) applyProfileUnlink(actor Principal, source string, claim ProfilePolicyUnlink) error {
	if !isDigest(source) || source == s.Owner || !isDigest(claim.CutoverDigest) || !validRecoveryProof(claim.ServerKey, 32) ||
		!validProfileLinkTime(claim.At, claim.ExpiresAt) || !validRecoveryProof(claim.DeviceProof, 64) {
		return InvalidAction
	}
	if !s.PolicyAnchored || !s.Members[actor.ProfileID].Active || !s.hasPolicyDevice(actor) || s.ProfileBindings[source] != actor.ProfileID {
		return Inactive
	}
	if err := s.profileGroupBan(actor.ProfileID, claim.At); err != nil {
		return err
	}
	delete(s.ProfileBindings, source)
	for id, origin := range s.ProfileDeviceOrigins {
		if origin != source {
			continue
		}
		device := s.PolicyDevices[id]
		if claim.GrantDeviceRebind && !device.Revoked {
			if s.DetachedPolicyDevices == nil {
				s.DetachedPolicyDevices = make(map[string]string)
			}
			s.DetachedPolicyDevices[id] = source
		}
		device.ProfileID, device.Revoked = source, true
		s.PolicyDevices[id] = device
		delete(s.ProfileDeviceOrigins, id)
		if recipient, ok := s.KeyRecipients[id]; ok && recipient.Kind == "device" {
			delete(s.KeyRecipients, id)
			if s.RetiredRecipientKeys == nil {
				s.RetiredRecipientKeys = make(map[string]bool)
			}
			s.RetiredRecipientKeys[recipient.PublicKey] = true
		}
	}
	s.refreshAdmissions()
	return nil
}

// ProfileGroup returns the signed effective identity and every linked source.
// Callers can enforce inherited restrictions without relying on legacy writes.
func (s State) ProfileGroup(profile string) []string {
	if primary := s.ProfileBindings[profile]; primary != "" {
		profile = primary
	}
	result := []string{profile}
	for source, primary := range s.ProfileBindings {
		if primary == profile {
			result = append(result, source)
		}
	}
	slices.Sort(result[1:])
	return result
}
