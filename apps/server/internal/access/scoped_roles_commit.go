package access

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"reflect"
	"strconv"
)

const EditScopedRoles = "roles.scoped"

var ErrScopedRoleSignature = errors.New("invalid protected role editor signature")

type ScopedRoleEdit struct {
	Change        ScopedRoleChange
	CutoverDigest string
	EditorProof   string
	ServerKey     string
}

// ScopedRoleEditFrame signs only the requested changes and their exact policy
// predecessor. The signing device never receives the policy projection seed.
func ScopedRoleEditFrame(serverID string, actor Principal, operationID string, edit ScopedRoleEdit) ([]byte, error) {
	change := edit.Change
	domain, roster := "pawtalk-protected-roles-edit-v1", change.RosterChannel
	if change.RosterCommitment != "" {
		if !isDigest(change.RosterCommitment) || change.TargetProfile == "" {
			return nil, InvalidAction
		}
		domain, roster = "pawtalk-protected-roles-edit-v2", change.RosterCommitment
	}
	fields := []string{serverID, edit.CutoverDigest,
		actor.ProfileID, actor.DeviceID, operationID, strconv.FormatInt(change.Revision, 10), change.PolicyHead,
		change.TargetProfile, roster}
	appendList := func(values []string) {
		fields = append(fields, strconv.Itoa(len(values)))
		fields = append(fields, values...)
	}
	appendList(change.Add)
	appendList(change.Remove)
	appendList(change.Delete)
	if change.Order == nil {
		fields = append(fields, "-")
	} else {
		appendList(*change.Order)
	}
	if change.Definitions == nil {
		fields = append(fields, "-")
	} else {
		fields = append(fields, strconv.Itoa(len(*change.Definitions)))
		for _, definition := range *change.Definitions {
			fields = append(fields, definition.ID)
			appendList(definition.Grants)
			if entry := definition.Presentation; entry != nil {
				fields = append(fields, "1", entry.Name, entry.Color, entry.Icon,
					strconv.FormatBool(entry.Hoist), strconv.FormatBool(entry.Mentionable))
			} else {
				fields = append(fields, "0")
			}
		}
	}
	hash := sha256.New()
	for _, field := range fields {
		encoded, err := SignatureFrame(field)
		if err != nil {
			return nil, InvalidAction
		}
		hash.Write(encoded)
	}
	return SignatureFrame(domain, hex.EncodeToString(hash.Sum(nil)))
}

func (s State) scopedRoleEdit(actor Principal, draft PolicyDraft, head PolicyProof) (RolePolicyUpdate, error) {
	change := draft.ResourceChange
	if change == nil || change.RolesEdit == nil || *change != (PolicyResourceChange{RolesEdit: change.RolesEdit}) ||
		draft.RoleUpdate != nil || draft.DeviceChange != nil || draft.PublicKey != "" {
		return RolePolicyUpdate{}, InvalidAction
	}
	edit := change.RolesEdit
	if !isDigest(edit.CutoverDigest) || !validRecoveryProof(edit.EditorProof, ed25519.SignatureSize) ||
		!validRecoveryProof(edit.ServerKey, ed25519.PublicKeySize) {
		return RolePolicyUpdate{}, InvalidAction
	}
	if !s.hasPolicyDevice(actor) || edit.Change.Revision != head.Draft.Revision || edit.Change.PolicyHead != head.Digest {
		return RolePolicyUpdate{}, ErrPolicyConflict
	}
	if err := validateScopedRoleRosterCommitment(head, edit.Change); err != nil {
		return RolePolicyUpdate{}, err
	}
	return s.scopedRoleUpdate(actor, edit.Change)
}

func validateScopedRoleRosterCommitment(head PolicyProof, change ScopedRoleChange) error {
	if head.Draft.TextProjectionVersion != ProfileRoleAuthorityProjectionVersion || change.RosterChannel == "" {
		if change.RosterCommitment != "" {
			return InvalidAction
		}
		return nil
	}
	var seed [32]byte
	if !isDigest(head.Draft.TextProjectionSeed) {
		return ErrPolicyConflict
	}
	_, _ = hex.Decode(seed[:], []byte(head.Draft.TextProjectionSeed))
	expected, _ := scopedRoleRosterAlias(seed, change.RosterChannel)
	if change.RosterCommitment != expected {
		return InvalidAction
	}
	return nil
}

func VerifyScopedRoleEdit(ctx context.Context, query SessionQuery, serverID string, actor Principal, draft PolicyDraft) error {
	state, head, err := readPrecedingPolicyState(ctx, query, draft)
	if err != nil {
		return err
	}
	if _, err := state.scopedRoleEdit(actor, draft, head); err != nil {
		return err
	}
	edit := *draft.ResourceChange.RolesEdit
	frame, err := ScopedRoleEditFrame(serverID, actor, draft.OperationID, edit)
	if err != nil {
		return err
	}
	device := state.PolicyDevices[actor.DeviceID]
	if !signingKeyMatches(actor.DeviceID, device.PublicKey) ||
		!verifyScopeAuthoritySignature(parseScopeAuthorityKey(device.PublicKey), frame, edit.EditorProof) {
		return ErrScopedRoleSignature
	}
	return nil
}

func (s *Store) CommitScopedRoleEdit(ctx context.Context, resolve ResolveSession, intent PolicyDraft,
	sign SignServerPolicyDraft, verify VerifyPolicyDraft) (PolicyProof, error) {
	if intent.Action != EditScopedRoles || intent.ResourceChange == nil || intent.ResourceChange.RolesEdit == nil ||
		!validRecoveryIntentFields(intent) || resolve == nil || sign == nil || verify == nil {
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
	state, head, err := readCommittedPolicyState(ctx, tx)
	if err != nil {
		return PolicyProof{}, err
	}
	permission := "role.edit"
	if intent.ResourceChange.RolesEdit.Change.TargetProfile != "" {
		permission = "role.assign"
	}
	if !state.hasPolicyDevice(actor) || state.CheckGrant(state.Members[actor.ProfileID], Scope{}, permission, 0) != Allowed {
		return PolicyProof{}, MissingGrant
	}
	prior, err := readStoredPolicyProof(ctx, tx, tx.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE operation_id=?`, intent.OperationID))
	if err == nil {
		if prior.Principal != actor || prior.Draft.Action != intent.Action || prior.Draft.PreviousDigest != intent.PreviousDigest ||
			!reflect.DeepEqual(prior.Draft.ResourceChange, intent.ResourceChange) {
			return PolicyProof{}, ErrPolicyConflict
		}
		return prior, verify(ctx, tx, actor, prior.Draft)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return PolicyProof{}, err
	}
	if head.Digest != intent.PreviousDigest {
		return PolicyProof{}, ErrPolicyConflict
	}
	var seed [32]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return PolicyProof{}, err
	}
	intent.TextProjectionSeed = hex.EncodeToString(seed[:])
	intent.TextProjectionVersion = head.Draft.TextProjectionVersion
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
	return proof, tx.Commit()
}
