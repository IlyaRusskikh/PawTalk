package access

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

const scopeDeviceHandoverLifetime = 15 * time.Minute

var ErrScopeDeviceHandoverExpired = errors.New("protected scope device handover expired")

// ScopeDevicePolicyHandover commits a change of signer inside the current
// owner profile. The other policy state stays the same.
type ScopeDevicePolicyHandover struct {
	Link          ScopeAuthorityLink
	CutoverDigest string
	ServerKey     string
	At            int64
}

// CommitScopeDeviceHandover authenticates the successor. The resulting policy
// proof records the previous signer as principal and embeds both consents.
func (s *Store) CommitScopeDeviceHandover(ctx context.Context, resolve ResolveSession, link ScopeAuthorityLink, cutover, serverKey string,
	sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	key := parseScopeAuthorityKey(link.DeviceKey)
	if link.Action != MoveScopeDevice || !validRotationID(link.OperationID) || key == nil || !isDigest(cutover) ||
		!validRecoveryProof(serverKey, ed25519.PublicKeySize) || resolve == nil || sign == nil || verify == nil {
		return PolicyProof{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return PolicyProof{}, err
	}
	defer tx.Rollback()
	successor, err := resolve(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	if hexHash(key) != successor.DeviceID {
		return PolicyProof{}, MissingGrant
	}
	prior, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE operation_id=?`, link.OperationID))
	if err == nil {
		change := prior.Draft.ResourceChange
		if prior.Draft.Action != MoveScopeDevice || prior.Principal.ProfileID != successor.ProfileID || change == nil ||
			change.ScopeDeviceHandover == nil || change.ScopeDeviceHandover.Link != link ||
			change.ScopeDeviceHandover.ServerKey != serverKey || change.ScopeDeviceHandover.CutoverDigest != cutover {
			return PolicyProof{}, ErrPolicyConflict
		}
		return prior, verify(ctx, tx, prior.Principal, prior.Draft)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, err
	}
	state, head, err := readCommittedPolicyState(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	if successor.ProfileID != state.Owner || !state.hasPolicyDevice(successor) || !state.Members[successor.ProfileID].Active {
		return PolicyProof{}, MissingGrant
	}
	if link.PolicyHead != head.Digest || link.Revision != head.Draft.Revision+1 {
		return PolicyProof{}, ErrPolicyConflict
	}
	if err := verify(ctx, tx, head.Principal, head.Draft); err != nil {
		return PolicyProof{}, err
	}
	now := s.now()
	if !validProfileLinkTime(now.UnixMilli(), link.ExpiresAt) || link.ExpiresAt > now.Add(scopeDeviceHandoverLifetime).UnixMilli() {
		return PolicyProof{}, ErrScopeDeviceHandoverExpired
	}
	actor := Principal{ProfileID: successor.ProfileID, DeviceID: link.SourceDeviceID}
	intent := PolicyDraft{Action: MoveScopeDevice, OperationID: link.OperationID, PreviousDigest: link.PolicyHead,
		TextProjectionVersion: head.Draft.TextProjectionVersion, ResourceChange: &PolicyResourceChange{ID: actor.ProfileID,
			ScopeDeviceHandover: &ScopeDevicePolicyHandover{Link: link, CutoverDigest: cutover, ServerKey: serverKey, At: now.UnixMilli()}}}
	if head.Draft.TextProjectionSeed != "" {
		var seed [32]byte
		if _, err := rand.Read(seed[:]); err != nil {
			return PolicyProof{}, err
		}
		intent.TextProjectionSeed = hex.EncodeToString(seed[:])
	}
	draft, err := preparePolicyDraft(&state, head.Draft.Revision, head, actor, intent)
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
	if link.ExpiresAt <= s.now().UnixMilli() {
		return PolicyProof{}, ErrScopeDeviceHandoverExpired
	}
	return proof, tx.Commit()
}

func (s State) checkScopeDeviceHandover(actor Principal, draft PolicyDraft, revision int64, predecessor string) error {
	resource := draft.ResourceChange
	if resource == nil || resource.ScopeDeviceHandover == nil ||
		*resource != (PolicyResourceChange{ID: actor.ProfileID, ScopeDeviceHandover: resource.ScopeDeviceHandover}) {
		return InvalidAction
	}
	change := resource.ScopeDeviceHandover
	link := change.Link
	if !s.PolicyAnchored || actor.ProfileID != s.Owner || !s.Members[s.Owner].Active || !s.hasPolicyDevice(actor) ||
		link.Action != MoveScopeDevice || link.SourceDeviceID != actor.DeviceID || link.Revision != revision ||
		link.OperationID != draft.OperationID || link.PolicyHead != predecessor ||
		!isDigest(change.CutoverDigest) || !validRecoveryProof(change.ServerKey, ed25519.PublicKeySize) || !validProfileLinkTime(change.At, link.ExpiresAt) {
		return ErrScopeAuthority
	}
	key := parseScopeAuthorityKey(link.DeviceKey)
	if key == nil {
		return ErrScopeAuthority
	}
	successor := hexHash(key)
	if successor == actor.DeviceID || !s.hasPolicyDevice(Principal{ProfileID: s.Owner, DeviceID: successor}) ||
		s.PolicyDevices[successor].PublicKey != link.DeviceKey {
		return ErrScopeAuthority
	}
	identity := s.RecoveryIdentities[s.Owner]
	if identity.ID != link.RecoveryID || identity.SigningKey != link.RecoveryKey {
		return ErrScopeAuthority
	}
	return nil
}

// VerifyScopeDeviceHandover checks the exact previous policy and the compact
// certificates that restricted recipients use to verify the same transition.
func VerifyScopeDeviceHandover(ctx context.Context, query ScopeAuthorityQuery, serverID, cutover string, actor Principal, draft PolicyDraft) error {
	if draft.Action != MoveScopeDevice || draft.ResourceChange == nil || draft.ResourceChange.ScopeDeviceHandover == nil ||
		draft.ResourceChange.ScopeDeviceHandover.CutoverDigest != cutover {
		return InvalidAction
	}
	revision, err := scopeAuthorityDraftRevision(ctx, query, draft)
	if err != nil {
		return err
	}
	draft.Revision = revision
	prior, _, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return err
	}
	if err := prior.checkScopeDeviceHandover(actor, draft, revision, draft.PreviousDigest); err != nil {
		return err
	}
	proofs, previous, err := ReadScopeAuthorityProofs(ctx, query, serverID, cutover, revision-1)
	if err != nil {
		return err
	}
	if previous.OwnerProfileID != actor.ProfileID || previous.DeviceID != actor.DeviceID {
		return ErrScopeAuthority
	}
	anchor, genesis, err := readScopeAuthorityGenesis(ctx, query)
	if err != nil {
		return err
	}
	binding := ScopeAuthorityContext{ServerID: serverID, CutoverDigest: cutover, AnchorDigest: anchor.Digest,
		OwnerProfileID: genesis.Owner, OwnerDeviceID: anchor.Principal.DeviceID}
	_, err = VerifyScopeAuthorityChain(binding, proofs.GenesisDeviceKey, append(proofs.Links, draft.ResourceChange.ScopeDeviceHandover.Link))
	return err
}
