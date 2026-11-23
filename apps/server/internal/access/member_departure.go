package access

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"maps"
	"reflect"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrOwnerDeparture = errors.New("owner cannot leave the protected server")

type MemberPolicyDeparture struct {
	CutoverDigest   string
	ServerKey       string
	DeviceSignature string
	Reason          string `json:",omitempty"`
	ExpiresAt       int64  `json:",omitempty"`
	At              int64  `json:",omitempty"`
	LiftInherited   bool   `json:",omitempty"`
}

type MemberRemoval struct {
	Action    string
	Reason    string
	ExpiresAt int64 `json:",omitempty"`
	Lifted    bool  `json:",omitempty"`
}

type MemberBanError struct{ MemberRemoval }

func (MemberBanError) Error() string { return "protected member is banned" }

func ReadMemberRemoval(ctx context.Context, query SessionQuery, profile string) (MemberRemoval, error) {
	state, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return MemberRemoval{}, err
	}
	return state.MemberRemovals[profile], nil
}

func ReadInheritedBanLift(ctx context.Context, query SessionQuery, profile string) (bool, error) {
	state, _, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	return state.InheritedBanLifts[profile], err
}

type MemberBanInfo struct {
	ProfileID string `json:"profileId"`
	Reason    string `json:"reason"`
	ExpiresAt int64  `json:"expiresAt"`
	Inherited bool   `json:"inherited,omitempty"`
}

type MemberBanPage struct {
	Bans []MemberBanInfo `json:"bans"`
	Next string          `json:"next,omitempty"`
}

type ListInheritedBans func(context.Context, *sql.Conn, string, int64, int) ([]MemberBanInfo, error)
type HasInheritedBan func(context.Context, SessionQuery, string, int64) (bool, error)

func (s *Store) DispatchMemberBans(ctx context.Context, resolve ResolveSession, inherited ListInheritedBans, after string, deliver func(MemberBanPage) error) error {
	if after != "" && !isDigest(after) {
		return InvalidAction
	}
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) {
			return Inactive
		}
		now := s.now().UnixMilli()
		if result := state.CheckGrant(state.Members[actor.ProfileID], Scope{}, BanPolicyMember, now); result != Allowed {
			return result
		}
		const limit = 32
		bans := make(map[string]MemberBanInfo, limit+1)
		if inherited != nil {
			entries, err := inherited(ctx, conn, after, now, limit+1)
			if err != nil {
				return err
			}
			for _, entry := range entries {
				bans[entry.ProfileID] = entry
			}
		}
		var current int
		for _, profile := range slices.Sorted(maps.Keys(state.MemberRemovals)) {
			removal := state.MemberRemovals[profile]
			if profile <= after || !removal.BannedAt(now) {
				continue
			}
			if current > limit {
				break
			}
			if previous, ok := bans[profile]; !ok || previous.ExpiresAt != 0 &&
				(removal.ExpiresAt == 0 || removal.ExpiresAt >= previous.ExpiresAt) {
				bans[profile] = MemberBanInfo{ProfileID: profile, Reason: removal.Reason, ExpiresAt: removal.ExpiresAt}
			}
			current++
		}
		page := MemberBanPage{Bans: make([]MemberBanInfo, 0, min(limit, len(bans)))}
		for _, profile := range slices.Sorted(maps.Keys(bans)) {
			if len(page.Bans) == limit {
				page.Next = page.Bans[limit-1].ProfileID
				break
			}
			page.Bans = append(page.Bans, bans[profile])
		}
		return deliver(page)
	})
}

func (r MemberRemoval) BannedAt(now int64) bool {
	return r.Action == BanPolicyMember && !r.Lifted && (r.ExpiresAt == 0 || now < r.ExpiresAt)
}

type SignServerPolicyDraft func(context.Context, SessionQuery, Principal, PolicyDraft) ([]byte, error)

func IsMemberDepartureAction(action string) bool {
	return action == LeavePolicyMember || action == KickPolicyMember || action == BanPolicyMember || action == LiftPolicyMemberBan
}

func (s *State) applyMemberDeparture(actor Principal, action string, change PolicyResourceChange) error {
	departure, target := change.Departure, change.ID
	if departure == nil || change != (PolicyResourceChange{ID: target, Departure: departure}) ||
		!isDigest(departure.CutoverDigest) || !isDigest(target) {
		return InvalidAction
	}
	if departure.LiftInherited && (action != LiftPolicyMemberBan || s.InheritedBanLifts[target]) {
		return ErrPolicyConflict
	}
	if action == LeavePolicyMember {
		if target != actor.ProfileID || departure.Reason != "" || departure.ExpiresAt != 0 || departure.At != 0 {
			return InvalidAction
		}
		if target == s.Owner {
			return ErrOwnerDeparture
		}
	} else {
		lift := action == LiftPolicyMemberBan
		permission := action
		if lift {
			permission = BanPolicyMember
		}
		if target == actor.ProfileID || target == s.Owner || departure.At <= 0 {
			return HierarchyDenied
		}
		subject := s.Members[target]
		if departure.LiftInherited {
			subject.ID = target
		}
		if result := s.CheckAction(s.Members[actor.ProfileID], subject, Scope{}, permission, lift, departure.At); result != Allowed {
			return result
		}
		if departure.Reason != strings.TrimSpace(departure.Reason) || strings.IndexFunc(departure.Reason, unicode.IsControl) >= 0 ||
			!utf8.ValidString(departure.Reason) || utf8.RuneCountInString(departure.Reason) > 200 || !lift && departure.Reason == "" {
			return InvalidAction
		}
		if action != BanPolicyMember && departure.ExpiresAt != 0 ||
			departure.ExpiresAt != 0 && (departure.ExpiresAt <= departure.At || departure.ExpiresAt > maxInviteDate) {
			return InvalidAction
		}
		if lift {
			ban := s.MemberRemovals[target]
			if !ban.BannedAt(departure.At) && !departure.LiftInherited {
				return ErrPolicyConflict
			}
			if ban.BannedAt(departure.At) {
				ban.Lifted = true
				s.MemberRemovals[target] = ban
			}
			if departure.LiftInherited {
				if s.InheritedBanLifts == nil {
					s.InheritedBanLifts = make(map[string]bool)
				}
				s.InheritedBanLifts[target] = true
			}
			return nil
		}
		if s.MemberRemovals == nil {
			s.MemberRemovals = make(map[string]MemberRemoval)
		}
		s.MemberRemovals[target] = MemberRemoval{Action: action, Reason: departure.Reason, ExpiresAt: departure.ExpiresAt}
	}
	s.retireMemberCredentials(target)
	s.Members[target] = Subject{ID: target}
	s.refreshAdmissions()
	return nil
}

// CommitMemberDeparture authenticates a self-signed intent and commits the
// deterministic departure and token invalidation together. A retry of the
// same intent returns its original proof without touching a later membership.
func (s *Store) CommitMemberDeparture(ctx context.Context, actor Principal, intent PolicyDraft,
	resolve ResolveSession, inherited HasInheritedBan, verifyIntent VerifyPolicyDraft, sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	defer tx.Rollback()
	if !IsMemberDepartureAction(intent.Action) || intent.ResourceChange == nil || intent.ResourceChange.Departure == nil ||
		intent.ResourceChange.Departure.LiftInherited ||
		!isDigest(intent.PreviousDigest) || !validRotationID(intent.OperationID) {
		return PolicyProof{}, InvalidAction
	}
	if intent.Action != LeavePolicyMember {
		if resolve == nil {
			return PolicyProof{}, Inactive
		}
		active, err := resolve(ctx, tx)
		if err != nil {
			return PolicyProof{}, err
		}
		if active != actor {
			return PolicyProof{}, Inactive
		}
	}
	if err := verifyIntent(ctx, tx, actor, intent); err != nil {
		return PolicyProof{}, err
	}
	prior, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx,
		"SELECT revision,operation_id,digest,record FROM protected_policy_proofs WHERE operation_id=?", intent.OperationID))
	if err == nil {
		if prior.Draft.ResourceChange != nil && prior.Draft.ResourceChange.Departure != nil {
			intent.ResourceChange.Departure.At = prior.Draft.ResourceChange.Departure.At
			intent.ResourceChange.Departure.LiftInherited = prior.Draft.ResourceChange.Departure.LiftInherited
		}
		if prior.Principal != actor || prior.Draft.Action != intent.Action || prior.Draft.PreviousDigest != intent.PreviousDigest ||
			!reflect.DeepEqual(prior.Draft.ResourceChange, intent.ResourceChange) {
			return PolicyProof{}, ErrPolicyConflict
		}
		return prior, verify(ctx, tx, prior.Principal, prior.Draft)
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
	if intent.PreviousDigest != head.Digest {
		return PolicyProof{}, ErrPolicyConflict
	}
	if intent.Action != LeavePolicyMember {
		intent.ResourceChange.Departure.At = s.now().UnixMilli()
	}
	if target := intent.ResourceChange.ID; intent.Action == LiftPolicyMemberBan && inherited != nil && !state.InheritedBanLifts[target] {
		active, err := inherited(ctx, tx, target, intent.ResourceChange.Departure.At)
		if err != nil {
			return PolicyProof{}, err
		}
		intent.ResourceChange.Departure.LiftInherited = active
	}
	intent.TextProjectionVersion = head.Draft.TextProjectionVersion
	if head.Draft.TextProjectionSeed != "" {
		var seed [32]byte
		if _, err := rand.Read(seed[:]); err != nil {
			return PolicyProof{}, err
		}
		intent.TextProjectionSeed = hex.EncodeToString(seed[:])
	}
	draft, err := preparePolicyDraft(&state, revision, head, actor, intent)
	if err != nil {
		return PolicyProof{}, err
	}
	draft.Signature, err = sign(ctx, tx, actor, draft)
	if err != nil {
		return PolicyProof{}, err
	}
	proof, err := s.commitPolicyInTransaction(ctx, tx, actor, verify, draft, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	for deviceID, device := range state.PolicyDevices {
		if intent.Action == LiftPolicyMemberBan || device.ProfileID != intent.ResourceChange.ID {
			continue
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM protected_runtime_sessions WHERE device_id=?", deviceID); err != nil {
			return PolicyProof{}, err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM protected_pending_invite_sessions WHERE device_id=?", deviceID); err != nil {
			return PolicyProof{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return PolicyProof{}, err
	}
	return proof, nil
}
