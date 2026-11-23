package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type ScopeAuthorityProofs struct {
	GenesisDeviceKey string               `json:"genesisDeviceKey"`
	Links            []ScopeAuthorityLink `json:"links"`
}

type ScopeAuthorityQuery interface {
	SessionQuery
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type scopeAuthorityGenesisSnapshot struct {
	Owner              string
	PolicyDevices      map[string]PolicyDevice
	RecoveryIdentities map[string]RecoveryIdentity
	RecoveryReady      map[string]bool
}

func readScopeAuthorityGenesis(ctx context.Context, query SessionQuery) (PolicyProof, scopeAuthorityGenesisSnapshot, error) {
	var genesis scopeAuthorityGenesisSnapshot
	anchor, err := readAttestedProof(ctx, query, 1)
	if err != nil {
		return anchor, genesis, err
	}
	var snapshot []byte
	if err := query.QueryRowContext(ctx, "SELECT snapshot FROM protected_policy_proofs WHERE revision=1").Scan(&snapshot); err != nil {
		return anchor, genesis, err
	}
	if json.Unmarshal(snapshot, &genesis) != nil || hexHash(snapshot) != anchor.Draft.ResultDigest || genesis.Owner != anchor.Principal.ProfileID {
		return anchor, genesis, ErrPolicyConflict
	}
	device := genesis.PolicyDevices[anchor.Principal.DeviceID]
	if device.Revoked || device.ProfileID != genesis.Owner {
		return anchor, genesis, ErrPolicyConflict
	}
	return anchor, genesis, nil
}

func ReadGenesisScopeAuthority(ctx context.Context, query SessionQuery) (*ScopeAuthorityLink, error) {
	var exists bool
	if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_scope_authority_genesis' AND type='table')`).Scan(&exists); err != nil || !exists {
		return nil, err
	}
	var raw []byte
	err := query.QueryRowContext(ctx, "SELECT link FROM protected_scope_authority_genesis WHERE id=1").Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var link ScopeAuthorityLink
	if err := json.Unmarshal(raw, &link); err != nil {
		return nil, ErrScopeAuthority
	}
	return &link, nil
}

func verifyDetachedScopeGenesis(binding ScopeAuthorityContext, anchor PolicyProof, genesis scopeAuthorityGenesisSnapshot, link ScopeAuthorityLink) error {
	device := genesis.PolicyDevices[anchor.Principal.DeviceID]
	recovery := genesis.RecoveryIdentities[genesis.Owner]
	if !isDetachedScopeGenesis(binding, link) || link.OperationID != anchor.Draft.OperationID ||
		link.DeviceKey != device.PublicKey || link.RecoveryID != recovery.ID || link.RecoveryKey != recovery.SigningKey ||
		!genesis.RecoveryReady[genesis.Owner] {
		return ErrScopeAuthority
	}
	_, err := VerifyScopeAuthorityChain(binding, device.PublicKey, []ScopeAuthorityLink{link})
	return err
}

// VerifyMigrationGenesisScopeAuthority rechecks the cutover certificate on
// startup. The signed snapshot determines whether a certificate is required.
func VerifyMigrationGenesisScopeAuthority(ctx context.Context, query SessionQuery, serverID, cutoverDigest string) error {
	anchor, genesis, err := readScopeAuthorityGenesis(ctx, query)
	if err != nil {
		return err
	}
	link, err := ReadGenesisScopeAuthority(ctx, query)
	if err != nil {
		return err
	}
	if genesis.RecoveryIdentities[genesis.Owner].ID == "" && link == nil {
		return nil
	}
	if link == nil {
		return ErrScopeAuthority
	}
	binding := ScopeAuthorityContext{ServerID: serverID, CutoverDigest: cutoverDigest, AnchorDigest: anchor.Digest,
		OwnerProfileID: genesis.Owner, OwnerDeviceID: anchor.Principal.DeviceID}
	return verifyDetachedScopeGenesis(binding, anchor, genesis, *link)
}

// InstallGenesisScopeAuthority stores the detached certificate with the
// approved migration cutover, after the signed genesis digest is known.
func InstallGenesisScopeAuthority(ctx context.Context, tx *sql.Tx, serverID, cutoverDigest string, link ScopeAuthorityLink) error {
	anchor, genesis, err := readScopeAuthorityGenesis(ctx, tx)
	if err != nil {
		return err
	}
	binding := ScopeAuthorityContext{ServerID: serverID, CutoverDigest: cutoverDigest, AnchorDigest: anchor.Digest,
		OwnerProfileID: genesis.Owner, OwnerDeviceID: anchor.Principal.DeviceID}
	if err := verifyDetachedScopeGenesis(binding, anchor, genesis, link); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_scope_authority_genesis (
		id INTEGER PRIMARY KEY CHECK(id=1),link BLOB NOT NULL CHECK(length(link)<=2048)
	) STRICT`); err != nil {
		return err
	}
	raw, err := json.Marshal(link)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO protected_scope_authority_genesis(id,link) VALUES(1,?) ON CONFLICT(id) DO NOTHING", raw); err != nil {
		return err
	}
	existing, err := ReadGenesisScopeAuthority(ctx, tx)
	if err != nil {
		return err
	}
	if existing == nil || *existing != link {
		return ErrPolicyConflict
	}
	return nil
}

// ReadScopeAuthorityProofs returns only the owner certificates committed by
// signed policy transitions. No channel snapshot or coverage manifest is sent.
func ReadScopeAuthorityProofs(ctx context.Context, query ScopeAuthorityQuery, serverID, cutoverDigest string, through int64) (ScopeAuthorityProofs, ScopeAuthorityState, error) {
	var proofs ScopeAuthorityProofs
	anchor, genesis, err := readScopeAuthorityGenesis(ctx, query)
	if err != nil {
		return proofs, ScopeAuthorityState{}, err
	}
	binding := ScopeAuthorityContext{ServerID: serverID, CutoverDigest: cutoverDigest, AnchorDigest: anchor.Digest,
		OwnerProfileID: genesis.Owner, OwnerDeviceID: anchor.Principal.DeviceID}
	proofs.GenesisDeviceKey = genesis.PolicyDevices[anchor.Principal.DeviceID].PublicKey
	proofs.Links = []ScopeAuthorityLink{}
	if through >= 1 {
		link, err := ReadGenesisScopeAuthority(ctx, query)
		if err != nil {
			return proofs, ScopeAuthorityState{}, err
		}
		if link != nil {
			if err := verifyDetachedScopeGenesis(binding, anchor, genesis, *link); err != nil {
				return proofs, ScopeAuthorityState{}, err
			}
			proofs.Links = append(proofs.Links, *link)
		}
	}
	rows, err := query.QueryContext(ctx, `SELECT revision,operation_id,digest,record,
		(SELECT prior.digest FROM protected_policy_proofs prior WHERE prior.revision=proof.revision-1)
		FROM protected_policy_proofs proof WHERE revision>? AND revision<=? AND (`+scopeAuthorityProofPredicate+`) ORDER BY revision`, 1, through)
	if err != nil {
		return proofs, ScopeAuthorityState{}, err
	}
	defer rows.Close()
	owner, authorityDevice := genesis.Owner, anchor.Principal.DeviceID
	for rows.Next() {
		var revision int64
		var operation, digest, previous string
		var record []byte
		if err := rows.Scan(&revision, &operation, &digest, &record, &previous); err != nil {
			return proofs, ScopeAuthorityState{}, err
		}
		var applied PolicyProof
		if err := json.Unmarshal(record, &applied); err != nil || applied.Principal.ProfileID != owner ||
			applied.Draft.Revision != revision || applied.Draft.OperationID != operation ||
			applied.Draft.PreviousDigest != previous || len(applied.Draft.Signature) != 64 || hexHash(applied.Draft.Signature) != digest {
			return proofs, ScopeAuthorityState{}, ErrPolicyConflict
		}
		var link *ScopeAuthorityLink
		switch applied.Draft.Action {
		case TransferScopeOwner:
			if applied.Principal.DeviceID != authorityDevice {
				return proofs, ScopeAuthorityState{}, ErrPolicyConflict
			}
			link, err = ownershipScopeAuthorityProof(ctx, query, applied.Principal, applied.Draft, revision)
			if err != nil {
				return proofs, ScopeAuthorityState{}, err
			}
			resultOwner, err := readScopeAuthoritySnapshotOwner(ctx, query, revision)
			if err != nil {
				return proofs, ScopeAuthorityState{}, err
			}
			if resultOwner != link.TargetProfileID {
				return proofs, ScopeAuthorityState{}, ErrPolicyConflict
			}
			owner = link.TargetProfileID
		case MoveScopeDevice:
			prior, _, err := readPrecedingPolicyState(ctx, query, applied.Draft)
			if err != nil {
				return proofs, ScopeAuthorityState{}, err
			}
			if applied.Principal.DeviceID != authorityDevice ||
				prior.checkScopeDeviceHandover(applied.Principal, applied.Draft, revision, previous) != nil {
				return proofs, ScopeAuthorityState{}, ErrScopeAuthority
			}
			if applied.Draft.ResourceChange.ScopeDeviceHandover.CutoverDigest != cutoverDigest {
				return proofs, ScopeAuthorityState{}, ErrScopeAuthority
			}
			link = &applied.Draft.ResourceChange.ScopeDeviceHandover.Link
		default:
			var recoveryID, recoveryKey string
			link, recoveryID, recoveryKey, err = recoveryScopeAuthorityFields(applied.Draft)
			if err != nil || link == nil || !scopeAuthorityMatchesDraft(link, applied.Draft, applied.Principal, revision, recoveryID, recoveryKey) {
				return proofs, ScopeAuthorityState{}, ErrPolicyConflict
			}
		}
		if link.Action == RecoverPolicyDevice || link.Action == TransferScopeOwner || link.Action == MoveScopeDevice {
			key := parseScopeAuthorityKey(link.DeviceKey)
			if key == nil {
				return proofs, ScopeAuthorityState{}, ErrScopeAuthority
			}
			authorityDevice = hexHash(key)
		}
		proofs.Links = append(proofs.Links, *link)
	}
	if err := rows.Err(); err != nil {
		return proofs, ScopeAuthorityState{}, err
	}
	state, err := VerifyScopeAuthorityChain(binding, proofs.GenesisDeviceKey, proofs.Links)
	if err != nil {
		return proofs, state, err
	}
	if through > 1 {
		currentOwner, err := readScopeAuthoritySnapshotOwner(ctx, query, through)
		if err != nil {
			return proofs, ScopeAuthorityState{}, err
		}
		if currentOwner != state.OwnerProfileID {
			return proofs, ScopeAuthorityState{}, ErrPolicyConflict
		}
	}
	return proofs, state, nil
}

const scopeAuthorityProofPredicate = `json_type(CAST(record AS TEXT),'$.Draft.ResourceChange.Recovery.ScopeAuthority')='object'
	OR json_type(CAST(record AS TEXT),'$.Draft.ResourceChange.RecoveryDevice.ScopeAuthority')='object'
	OR json_extract(CAST(record AS TEXT),'$.Draft.Action') IN ('owner.transfer','scope.device')`

func readScopeAuthoritySnapshotOwner(ctx context.Context, query SessionQuery, revision int64) (string, error) {
	var state struct{ Owner string }
	proof, err := readAttestedProof(ctx, query, revision)
	if err != nil {
		return "", err
	}
	var snapshot []byte
	if err := query.QueryRowContext(ctx, "SELECT snapshot FROM protected_policy_proofs WHERE revision=?", revision).Scan(&snapshot); err != nil {
		return "", err
	}
	if hexHash(snapshot) != proof.Draft.ResultDigest || json.Unmarshal(snapshot, &state) != nil {
		return "", ErrPolicyConflict
	}
	return state.Owner, nil
}

func recoveryScopeAuthorityFields(draft PolicyDraft) (*ScopeAuthorityLink, string, string, error) {
	if draft.ResourceChange == nil {
		return nil, "", "", InvalidAction
	}
	if value := draft.ResourceChange.Recovery; draft.Action == EnrollPolicyRecovery && value != nil {
		return value.ScopeAuthority, value.RecoveryID, value.SigningKey, nil
	}
	if value := draft.ResourceChange.RecoveryDevice; draft.Action == RecoverPolicyDevice && value != nil {
		return value.ScopeAuthority, value.RecoveryID, "", nil
	}
	return nil, "", "", InvalidAction
}

func scopeAuthorityMatchesDraft(link *ScopeAuthorityLink, draft PolicyDraft, actor Principal, revision int64, recoveryID, recoveryKey string) bool {
	if link.Revision != revision || link.OperationID != draft.OperationID || link.PolicyHead != draft.PreviousDigest ||
		link.RecoveryID != recoveryID || !signingKeyMatches(actor.DeviceID, link.DeviceKey) {
		return false
	}
	if draft.Action == EnrollPolicyRecovery {
		return link.Action == "recovery.authorize" && link.RecoveryKey == recoveryKey
	}
	return link.Action == RecoverPolicyDevice && link.DeviceKey == draft.ResourceChange.RecoveryDevice.SigningKey
}

func ownershipScopeAuthorityProof(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft, revision int64) (*ScopeAuthorityLink, error) {
	if revision < 2 || draft.ResourceChange == nil || draft.ResourceChange.OwnershipTransfer == nil {
		return nil, ErrPolicyConflict
	}
	link := draft.ResourceChange.OwnershipTransfer
	if link.Action != TransferScopeOwner || link.Revision != revision || link.OperationID != draft.OperationID ||
		link.PolicyHead != draft.PreviousDigest || link.TargetProfileID != draft.ResourceChange.ID || link.Transfer == nil {
		return nil, ErrPolicyConflict
	}
	draft.Revision = revision
	if _, err := ReadOwnerTransferBasis(ctx, query, actor, draft); err != nil {
		return nil, err
	}
	if !link.Transfer.proves(link.DeviceKey) {
		return nil, ErrScopeAuthority
	}
	return link, nil
}

// VerifyOwnershipScopeAuthority checks the signed offer and accepted
// device against the predecessor's full policy, independent of storage order.
func VerifyOwnershipScopeAuthority(ctx context.Context, query ScopeAuthorityQuery, serverID, cutoverDigest string,
	actor Principal, draft PolicyDraft) error {
	if draft.Action != TransferScopeOwner {
		return InvalidAction
	}
	anchor, err := readAttestedProof(ctx, query, 1)
	if err != nil {
		return err
	}
	revision, err := scopeAuthorityDraftRevision(ctx, query, draft)
	if err != nil {
		return err
	}
	link, err := ownershipScopeAuthorityProof(ctx, query, actor, draft, revision)
	if err != nil {
		return err
	}
	proofs, previous, err := ReadScopeAuthorityProofs(ctx, query, serverID, cutoverDigest, revision-1)
	if err != nil {
		return err
	}
	if actor.ProfileID != previous.OwnerProfileID || actor.DeviceID != previous.DeviceID {
		return ErrScopeAuthority
	}
	binding := ScopeAuthorityContext{ServerID: serverID, CutoverDigest: cutoverDigest, AnchorDigest: anchor.Digest,
		OwnerProfileID: anchor.Principal.ProfileID, OwnerDeviceID: anchor.Principal.DeviceID}
	_, err = VerifyScopeAuthorityChain(binding, proofs.GenesisDeviceKey, append(proofs.Links, *link))
	return err
}

func scopeAuthorityDraftRevision(ctx context.Context, query SessionQuery, draft PolicyDraft) (int64, error) {
	if draft.Revision != 0 {
		return draft.Revision, nil
	}
	head, err := readPolicyHead(ctx, query)
	if err != nil {
		return 0, err
	}
	if head.Digest != draft.PreviousDigest {
		return 0, ErrPolicyConflict
	}
	return head.Draft.Revision + 1, nil
}

// VerifyRecoveryScopeAuthority enforces the compact certificate at the exact
// revision and policy parent being signed. Existing proofs predating compact
// authority remain readable. Once installed, the chain cannot be bypassed.
func VerifyRecoveryScopeAuthority(ctx context.Context, query ScopeAuthorityQuery, serverID, cutoverDigest string, actor Principal, draft PolicyDraft) error {
	link, recoveryID, recoveryKey, err := recoveryScopeAuthorityFields(draft)
	if err != nil {
		return err
	}
	anchor, err := readAttestedProof(ctx, query, 1)
	if err != nil {
		return err
	}
	revision, err := scopeAuthorityDraftRevision(ctx, query, draft)
	if err != nil {
		return err
	}
	proofs, previous, err := ReadScopeAuthorityProofs(ctx, query, serverID, cutoverDigest, revision-1)
	if err != nil {
		return err
	}
	if actor.ProfileID != previous.OwnerProfileID {
		if link != nil {
			return InvalidAction
		}
		return nil
	}
	if link == nil {
		if previous.Sequence != 0 {
			return ErrPolicyConflict
		}
		return nil
	}
	if !scopeAuthorityMatchesDraft(link, draft, actor, revision, recoveryID, recoveryKey) {
		return ErrPolicyConflict
	}
	binding := ScopeAuthorityContext{ServerID: serverID, CutoverDigest: cutoverDigest, AnchorDigest: anchor.Digest,
		OwnerProfileID: anchor.Principal.ProfileID, OwnerDeviceID: anchor.Principal.DeviceID}
	_, err = VerifyScopeAuthorityChain(binding, proofs.GenesisDeviceKey, append(proofs.Links, *link))
	return err
}
