package access

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"reflect"
	"slices"
	"time"
)

const TransferPolicyOwnership = "owner.transfer"

const ownerTransferLifetime = 15 * time.Minute

var ErrOwnerTransferUnavailable = errors.New("protected owner transfer unavailable")

type OwnerTransferCandidate struct {
	DeviceID   string `json:"deviceId"`
	SigningKey string `json:"signingKey"`
}

type OwnerTransferOffer struct {
	OperationID     string                   `json:"operationId"`
	OwnerProfileID  string                   `json:"ownerProfileId"`
	OwnerDeviceID   string                   `json:"ownerDeviceId"`
	TargetProfileID string                   `json:"targetProfileId"`
	PolicyHead      string                   `json:"policyHead"`
	HeadRevision    int64                    `json:"headRevision"`
	ExpiresAt       int64                    `json:"expiresAt"`
	Sequence        int64                    `json:"sequence"`
	Previous        string                   `json:"previous"`
	RecoveryID      string                   `json:"recoveryId"`
	RecoveryKey     string                   `json:"recoveryKey"`
	CandidatesRoot  string                   `json:"candidatesRoot"`
	Candidates      []OwnerTransferCandidate `json:"candidates"`
	Authorization   string                   `json:"authorization"`
}

type VerifyOwnerTransferOffer func(context.Context, SessionQuery, Principal, OwnerTransferOffer) error

type CertifyOwnerTransfer func(context.Context, SessionQuery, Principal, OwnerTransferOffer) (ScopeAuthorityLink, error)

func EnsureOwnerTransferSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_owner_transfer_offers (
		operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=32),
		pending INTEGER NOT NULL CHECK(pending IN (0,1)),
		offer BLOB NOT NULL
	) STRICT;
	CREATE UNIQUE INDEX IF NOT EXISTS protected_owner_transfer_pending ON protected_owner_transfer_offers(pending) WHERE pending=1;`)
	return err
}

func (s State) ownerTransferBasis(actor Principal, target string, now int64) (RecoveryIdentity, []OwnerTransferCandidate, string, error) {
	if !s.PolicyAnchored || s.Owner != actor.ProfileID || !s.hasPolicyDevice(actor) || !s.Members[actor.ProfileID].Active {
		return RecoveryIdentity{}, nil, "", MissingGrant
	}
	if removal := s.MemberRemovals[actor.ProfileID]; removal.BannedAt(now) {
		return RecoveryIdentity{}, nil, "", MemberBanError{removal}
	}
	if !isDigest(target) || target == actor.ProfileID {
		return RecoveryIdentity{}, nil, "", InvalidAction
	}
	if removal := s.MemberRemovals[target]; removal.BannedAt(now) {
		return RecoveryIdentity{}, nil, "", MemberBanError{removal}
	}
	if !s.Members[target].Active {
		return RecoveryIdentity{}, nil, "", Inactive
	}
	if !s.RecoveryReady[target] {
		return RecoveryIdentity{}, nil, "", RecoveryRequired
	}
	identity, err := s.recoveryDeviceIdentity(target, now)
	if err != nil {
		return RecoveryIdentity{}, nil, "", err
	}
	candidates, err := s.ownershipTransferCandidates(target)
	if err != nil {
		return RecoveryIdentity{}, nil, "", err
	}
	keys := make([]string, len(candidates))
	for i, candidate := range candidates {
		keys[i] = candidate.SigningKey
	}
	root, err := ScopeOwnershipCandidatesRoot(keys)
	if err != nil {
		return RecoveryIdentity{}, nil, "", err
	}
	return identity, candidates, root, nil
}

func (s State) ownershipTransferCandidates(target string) ([]OwnerTransferCandidate, error) {
	var candidates []OwnerTransferCandidate
	for _, id := range slices.Sorted(maps.Keys(s.PolicyDevices)) {
		device := s.PolicyDevices[id]
		if device.ProfileID != target || device.Revoked {
			continue
		}
		if !signingKeyMatches(id, device.PublicKey) {
			return nil, ErrPolicyConflict
		}
		candidates = append(candidates, OwnerTransferCandidate{DeviceID: id, SigningKey: device.PublicKey})
	}
	if len(candidates) == 0 {
		return nil, Inactive
	}
	return candidates, nil
}

func ownerTransferBasis(state State, head PolicyProof, actor Principal, target, operationID string, expiresAt, now int64) (OwnerTransferOffer, error) {
	if !validRotationID(operationID) || expiresAt <= 0 || expiresAt > maxInviteDate {
		return OwnerTransferOffer{}, InvalidAction
	}
	identity, candidates, root, err := state.ownerTransferBasis(actor, target, now)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	return OwnerTransferOffer{OperationID: operationID, OwnerProfileID: actor.ProfileID, OwnerDeviceID: actor.DeviceID,
		TargetProfileID: target, PolicyHead: head.Digest, HeadRevision: head.Draft.Revision, ExpiresAt: expiresAt,
		RecoveryID: identity.ID, RecoveryKey: identity.SigningKey, Candidates: candidates, CandidatesRoot: root}, nil
}

func (offer OwnerTransferOffer) matchesLink(link *ScopeAuthorityLink) bool {
	return link != nil && link.Transfer != nil && link.Action == TransferPolicyOwnership &&
		link.Revision == offer.HeadRevision+1 && link.PolicyHead == offer.PolicyHead && link.OperationID == offer.OperationID &&
		link.Sequence == offer.Sequence && link.Previous == offer.Previous && link.TargetProfileID == offer.TargetProfileID &&
		link.RecoveryID == offer.RecoveryID && link.RecoveryKey == offer.RecoveryKey && link.Authorization == offer.Authorization &&
		link.Transfer.CandidatesRoot == offer.CandidatesRoot && link.Transfer.ExpiresAt == offer.ExpiresAt &&
		link.Transfer.Count == len(offer.Candidates) && offer.containsSigningKey(link.DeviceKey) && link.Transfer.proves(link.DeviceKey)
}

func (offer OwnerTransferOffer) containsSigningKey(key string) bool {
	return slices.ContainsFunc(offer.Candidates, func(candidate OwnerTransferCandidate) bool { return candidate.SigningKey == key })
}

func (offer OwnerTransferOffer) containsActor(actor Principal) bool {
	return actor.ProfileID == offer.TargetProfileID && slices.ContainsFunc(offer.Candidates, func(candidate OwnerTransferCandidate) bool {
		return candidate.DeviceID == actor.DeviceID
	})
}

func ownerTransferFromLink(state State, head PolicyProof, actor Principal, change PolicyResourceChange, operationID string) (OwnerTransferOffer, error) {
	link := change.OwnershipTransfer
	if link == nil || link.Transfer == nil || change != (PolicyResourceChange{ID: change.ID, OwnershipTransfer: link}) ||
		link.Sequence < 1 || !isDigest(link.Previous) || !validRecoveryProof(link.Authorization, ed25519.SignatureSize) ||
		!validRecoveryProof(link.DeviceProof, ed25519.SignatureSize) {
		return OwnerTransferOffer{}, InvalidAction
	}
	offer, err := ownerTransferBasis(state, head, actor, change.ID, operationID, link.Transfer.ExpiresAt, 0)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	offer.Sequence, offer.Previous, offer.Authorization = link.Sequence, link.Previous, link.Authorization
	if !offer.matchesLink(link) {
		return OwnerTransferOffer{}, ErrPolicyConflict
	}
	return offer, nil
}

func (s *State) applyOwnerTransfer(actor Principal, change PolicyResourceChange, revision int64, previous, operationID string) error {
	head := PolicyProof{Draft: PolicyDraft{Revision: revision - 1}, Digest: previous}
	if _, err := ownerTransferFromLink(*s, head, actor, change, operationID); err != nil {
		return err
	}
	s.Owner = change.ID
	s.refreshAdmissions()
	return nil
}

// ReadOwnerTransferBasis reconstructs the offer from the exact predecessor
// snapshot. Verifiers can recheck its candidate commitment without live data.
func ReadOwnerTransferBasis(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) (OwnerTransferOffer, error) {
	if draft.Action != TransferPolicyOwnership || draft.ResourceChange == nil {
		return OwnerTransferOffer{}, InvalidAction
	}
	state, head, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	return ownerTransferFromLink(state, head, actor, *draft.ResourceChange, draft.OperationID)
}

func readCommittedPolicyState(ctx context.Context, query SessionQuery) (State, PolicyProof, error) {
	state, revision, err := readState(query.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	head, err := readPolicyHead(ctx, query)
	if err != nil {
		return State{}, PolicyProof{}, err
	}
	if err := checkPolicyHead(state, revision, head); err != nil {
		return State{}, PolicyProof{}, err
	}
	return state, head, nil
}

func validOwnerTransferDeadline(expiry, now int64) bool {
	return expiry > now && expiry <= now+ownerTransferLifetime.Milliseconds()
}

func (s *Store) PreviewOwnerTransferOffer(ctx context.Context, resolve ResolveSession, target, operationID string, expiresAt int64) (OwnerTransferOffer, error) {
	var offer OwnerTransferOffer
	err := s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		now := s.now().UnixMilli()
		if !validOwnerTransferDeadline(expiresAt, now) {
			return ErrOwnerTransferUnavailable
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		offer, err = ownerTransferBasis(state, head, actor, target, operationID, expiresAt, now)
		return err
	})
	return offer, err
}

func readPendingOwnerTransfer(ctx context.Context, query SessionQuery) (OwnerTransferOffer, error) {
	var offer OwnerTransferOffer
	var operation string
	var payload []byte
	err := query.QueryRowContext(ctx, `SELECT operation_id,offer FROM protected_owner_transfer_offers WHERE pending=1`).Scan(&operation, &payload)
	if err != nil {
		return offer, err
	}
	if json.Unmarshal(payload, &offer) != nil || offer.OperationID != operation {
		return OwnerTransferOffer{}, ErrPolicyConflict
	}
	return offer, nil
}

func (s *Store) CreateOwnerTransferOffer(ctx context.Context, resolve ResolveSession, offer OwnerTransferOffer, verifyOffer VerifyOwnerTransferOffer) (OwnerTransferOffer, error) {
	if verifyOffer == nil || offer.Sequence < 1 || !isDigest(offer.Previous) || !validRecoveryProof(offer.Authorization, ed25519.SignatureSize) {
		return OwnerTransferOffer{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	state, head, err := readCommittedPolicyState(ctx, tx)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	now := s.now().UnixMilli()
	if !validOwnerTransferDeadline(offer.ExpiresAt, now) {
		return OwnerTransferOffer{}, ErrOwnerTransferUnavailable
	}
	canonical, err := ownerTransferBasis(state, head, actor, offer.TargetProfileID, offer.OperationID, offer.ExpiresAt, now)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	canonical.Sequence, canonical.Previous, canonical.Authorization = offer.Sequence, offer.Previous, offer.Authorization
	if !reflect.DeepEqual(offer, canonical) {
		return OwnerTransferOffer{}, ErrPolicyConflict
	}
	if err := verifyOffer(ctx, tx, actor, canonical); err != nil {
		return OwnerTransferOffer{}, err
	}
	if offer.ExpiresAt <= s.now().UnixMilli() {
		return OwnerTransferOffer{}, ErrOwnerTransferUnavailable
	}
	pending, err := readPendingOwnerTransfer(ctx, tx)
	if err == nil {
		if pending.PolicyHead == head.Digest && pending.ExpiresAt > now {
			if reflect.DeepEqual(pending, canonical) {
				return pending, nil
			}
			return OwnerTransferOffer{}, ErrPolicyConflict
		}
		if _, err := tx.ExecContext(ctx, `UPDATE protected_owner_transfer_offers SET pending=0,offer=x'' WHERE operation_id=?`, pending.OperationID); err != nil {
			return OwnerTransferOffer{}, err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return OwnerTransferOffer{}, err
	}
	payload, err := json.Marshal(canonical)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO protected_owner_transfer_offers(operation_id,pending,offer) SELECT ?,1,?
		WHERE NOT EXISTS (SELECT 1 FROM protected_policy_proofs WHERE operation_id=?) ON CONFLICT DO NOTHING`,
		offer.OperationID, payload, offer.OperationID)
	if err != nil {
		return OwnerTransferOffer{}, err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return OwnerTransferOffer{}, err
		}
		return OwnerTransferOffer{}, ErrPolicyConflict
	}
	if err := tx.Commit(); err != nil {
		return OwnerTransferOffer{}, err
	}
	return canonical, nil
}

func (s *Store) DispatchOwnerTransferOffer(ctx context.Context, resolve ResolveSession, deliver func(OwnerTransferOffer) error) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
			return Inactive
		}
		offer, err := readPendingOwnerTransfer(ctx, conn)
		if errors.Is(err, sql.ErrNoRows) {
			return deliver(OwnerTransferOffer{})
		}
		if err != nil {
			return err
		}
		if (actor.ProfileID != offer.OwnerProfileID || actor.DeviceID != offer.OwnerDeviceID) && !offer.containsActor(actor) {
			return deliver(OwnerTransferOffer{})
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		if offer.PolicyHead != head.Digest || offer.ExpiresAt <= s.now().UnixMilli() {
			return deliver(OwnerTransferOffer{})
		}
		return deliver(offer)
	})
}

func (s *Store) CancelOwnerTransferOffer(ctx context.Context, resolve ResolveSession, operationID string) error {
	if !validRotationID(operationID) {
		return InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return err
	}
	state, _, err := readCommittedPolicyState(ctx, tx)
	if err != nil {
		return err
	}
	if !state.PolicyAnchored || state.Owner != actor.ProfileID || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
		return MissingGrant
	}
	if _, err := tx.ExecContext(ctx, `UPDATE protected_owner_transfer_offers SET pending=0,offer=x'' WHERE operation_id=? AND pending=1`, operationID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) CommitOwnerTransfer(ctx context.Context, resolve ResolveSession, operationID, serverKey string,
	certify CertifyOwnerTransfer, sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	if !validRotationID(operationID) || !validRecoveryProof(serverKey, ed25519.PublicKeySize) || certify == nil || sign == nil || verify == nil {
		return PolicyProof{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	defer tx.Rollback()
	accepting, err := resolve(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	state, head, err := readCommittedPolicyState(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	now := s.now().UnixMilli()
	if removal := state.MemberRemovals[accepting.ProfileID]; removal.BannedAt(now) {
		return PolicyProof{}, MemberBanError{removal}
	}
	if !state.PolicyAnchored || !state.Members[accepting.ProfileID].Active || !state.hasPolicyDevice(accepting) {
		return PolicyProof{}, Inactive
	}
	prior, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE operation_id=?`, operationID))
	if err == nil {
		if prior.Draft.Action != TransferPolicyOwnership || prior.Draft.ResourceChange == nil || prior.Draft.ResourceChange.OwnershipTransfer == nil ||
			prior.Draft.ResourceChange.ID != accepting.ProfileID || !signingKeyMatches(accepting.DeviceID, prior.Draft.ResourceChange.OwnershipTransfer.DeviceKey) {
			return PolicyProof{}, ErrOwnerTransferUnavailable
		}
		return prior, verify(ctx, tx, prior.Principal, prior.Draft)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, err
	}
	offer, err := readPendingOwnerTransfer(ctx, tx)
	if errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, ErrOwnerTransferUnavailable
	}
	if err != nil {
		return PolicyProof{}, err
	}
	if operationID != offer.OperationID || !offer.containsActor(accepting) || offer.ExpiresAt <= now {
		return PolicyProof{}, ErrOwnerTransferUnavailable
	}
	if offer.PolicyHead != head.Digest || offer.HeadRevision != head.Draft.Revision {
		return PolicyProof{}, ErrPolicyConflict
	}
	owner := Principal{ProfileID: offer.OwnerProfileID, DeviceID: offer.OwnerDeviceID}
	canonical, err := ownerTransferBasis(state, head, owner, offer.TargetProfileID, operationID, offer.ExpiresAt, now)
	if err != nil {
		return PolicyProof{}, err
	}
	canonical.Sequence, canonical.Previous, canonical.Authorization = offer.Sequence, offer.Previous, offer.Authorization
	if !reflect.DeepEqual(offer, canonical) {
		return PolicyProof{}, ErrPolicyConflict
	}
	link, err := certify(ctx, tx, accepting, offer)
	if err != nil {
		return PolicyProof{}, err
	}
	if !offer.matchesLink(&link) || !signingKeyMatches(accepting.DeviceID, link.DeviceKey) {
		return PolicyProof{}, ErrPolicyConflict
	}
	if offer.ExpiresAt <= s.now().UnixMilli() {
		return PolicyProof{}, ErrOwnerTransferUnavailable
	}
	intent := PolicyDraft{Action: TransferPolicyOwnership, OperationID: operationID, PublicKey: serverKey,
		TextProjectionVersion: head.Draft.TextProjectionVersion,
		ResourceChange:        &PolicyResourceChange{ID: offer.TargetProfileID, OwnershipTransfer: &link}}
	if head.Draft.TextProjectionSeed != "" {
		var seed [32]byte
		if _, err := rand.Read(seed[:]); err != nil {
			return PolicyProof{}, err
		}
		intent.TextProjectionSeed = hex.EncodeToString(seed[:])
	}
	draft, err := preparePolicyDraft(&state, head.Draft.Revision, head, owner, intent)
	if err != nil {
		return PolicyProof{}, err
	}
	draft.Signature, err = sign(ctx, tx, owner, draft)
	if err != nil {
		return PolicyProof{}, err
	}
	proof, err := s.commitPolicyInTransaction(ctx, tx, owner, verify, draft, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	if offer.ExpiresAt <= s.now().UnixMilli() {
		return PolicyProof{}, ErrOwnerTransferUnavailable
	}
	if _, err := tx.ExecContext(ctx, `UPDATE protected_owner_transfer_offers SET pending=0,offer=x'' WHERE operation_id=?`, operationID); err != nil {
		return PolicyProof{}, err
	}
	if err := tx.Commit(); err != nil {
		return PolicyProof{}, err
	}
	return proof, nil
}
