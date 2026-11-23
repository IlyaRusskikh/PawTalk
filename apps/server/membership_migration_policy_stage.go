package main

import (
	"cmp"
	"context"
	"crypto/ed25519"
	"database/sql"
	"io"
	"maps"
	"net/http"
	"path/filepath"
	"slices"
	"time"

	"pawtalk/server/internal/access"
)

type migrationInitialPolicy struct {
	Draft                access.PolicyDraft `json:"draft"`
	Snapshot             []byte             `json:"snapshot"`
	PreserveChannelOrder bool               `json:"preserveChannelOrder,omitempty"`
	RuntimeRecovery      bool               `json:"runtimeRecovery,omitempty"`
}

type migrationPolicyApproval struct {
	ReviewDigest     string `json:"reviewDigest"`
	PolicySignature  string `json:"policySignature"`
	ImportBinding    string `json:"importBinding"`
	ScopeAttestation string `json:"scopeAttestation,omitempty"`
}

func migrationInitialState(policy migrationPolicyDraft, owner string, recipient migrationRecipientReceipt, format migrationPolicyFormat) (access.State, access.Principal, error) {
	var initial access.State
	actor := access.Principal{ProfileID: owner, DeviceID: recipient.DeviceID}
	if policy.State == nil || policy.State.Owner != owner || policy.State.PolicyDevices[recipient.DeviceID].ProfileID != owner {
		return initial, actor, memberError(http.StatusConflict, "MIGRATION_INITIAL_POLICY_UNAVAILABLE")
	}
	initial = *policy.State
	if format.preserveChannelOrder {
		initial.ChannelOrder = slices.Collect(maps.Keys(initial.Channels))
		slices.SortFunc(initial.ChannelOrder, func(a, b string) int {
			if position := cmp.Compare(policy.ChannelMetadata[a].Position, policy.ChannelMetadata[b].Position); position != 0 {
				return position
			}
			return cmp.Compare(a, b)
		})
	}
	initial.KeyRecipients = map[string]access.KeyRecipient{
		recipient.DeviceID: {ProfileID: owner, Kind: "device", PublicKey: recipient.PublicKey},
	}
	if format.runtimeRecovery {
		recovery := policy.OwnerRecovery
		if recovery == nil || recovery.RecoveryID == recipient.DeviceID || recovery.AgreementKey == recipient.PublicKey {
			return access.State{}, actor, memberError(http.StatusConflict, "MIGRATION_INITIAL_POLICY_UNAVAILABLE")
		}
		initial.RecoveryIdentities = map[string]access.RecoveryIdentity{
			owner: {ID: recovery.RecoveryID, SigningKey: recovery.SigningKey, AgreementKey: recovery.AgreementKey},
		}
		initial.KeyRecipients[recovery.RecoveryID] = access.KeyRecipient{ProfileID: owner, Kind: "recovery", PublicKey: recovery.AgreementKey}
		// API 3 only opens after cutover verifies the full epoch recovery coverage.
		initial.RecoveryReady = map[string]bool{owner: true}
	}
	return initial, actor, nil
}

func previewMigrationInitialPolicy(policy migrationPolicyDraft, owner string, recipient migrationRecipientReceipt, format migrationPolicyFormat) (migrationInitialPolicy, error) {
	initial, actor, err := migrationInitialState(policy, owner, recipient, format)
	if err != nil {
		return migrationInitialPolicy{}, err
	}
	frame, err := signatureFrame("pawtalk-migration-initial-policy-operation-v1", recipient.ReviewDigest, recipient.DeviceID, recipient.PublicKey)
	if err != nil {
		return migrationInitialPolicy{}, err
	}
	draftProof, snapshot, err := access.PreviewInitialPolicy(initial, actor, publicKeyID(frame)[:32], format.seed, format.projectionVersion)
	return migrationInitialPolicy{Draft: draftProof, Snapshot: snapshot, PreserveChannelOrder: format.preserveChannelOrder,
		RuntimeRecovery: format.runtimeRecovery}, err
}

func migrationPolicyBindingFrame(authority migrationAuthority, report verifiedMigrationImport, draft access.PolicyDraft) ([]byte, error) {
	return signatureFrame("pawtalk-migration-initial-policy-binding-v1", authority.serverID, authority.archiveSHA256, authority.ownerID,
		report.OwnerRecipient.DeviceID, report.ReviewDigest, draft.OperationID, draft.ResultDigest, publicKeyID(draft.Signature))
}

func stageStandaloneMigrationPolicy(ctx context.Context, dir, archive string, input io.Reader) (access.PolicyProof, error) {
	invalid := memberError(http.StatusBadRequest, "INVALID_MIGRATION_POLICY_APPROVAL")
	var approval migrationPolicyApproval
	if !validHexID(archive, 64) || decodeMigrationHostInput(input, &approval) != nil || !validHexID(approval.ReviewDigest, 64) {
		return access.PolicyProof{}, invalid
	}
	policySignature, policyErr := decodeFixed(approval.PolicySignature, ed25519.SignatureSize)
	binding, bindingErr := decodeFixed(approval.ImportBinding, ed25519.SignatureSize)
	if policyErr != nil || bindingErr != nil {
		return access.PolicyProof{}, invalid
	}
	var scopeSignature []byte
	if approval.ScopeAttestation != "" {
		var err error
		scopeSignature, err = decodeFixed(approval.ScopeAttestation, ed25519.SignatureSize)
		if err != nil {
			return access.PolicyProof{}, invalid
		}
	}
	db, err := openMigrationImportDatabase(filepath.Join(dir, membershipDatabaseFile))
	if err != nil {
		return access.PolicyProof{}, err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return access.PolicyProof{}, err
	}
	defer tx.Rollback()
	store := &membershipStore{db: db, now: time.Now}
	report, err := store.readVerifiedMigrationImport(ctx, tx, dir, archive)
	if err != nil {
		return access.PolicyProof{}, err
	}
	if report.ReviewDigest != approval.ReviewDigest || report.InitialPolicy == nil {
		return access.PolicyProof{}, memberError(http.StatusConflict, "MIGRATION_INITIAL_POLICY_UNAVAILABLE")
	}
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		return access.PolicyProof{}, err
	}
	signed := report.InitialPolicy.Draft
	signed.Signature = policySignature
	frame, err := migrationPolicyBindingFrame(authority, report, signed)
	if err != nil {
		return access.PolicyProof{}, err
	}
	if err := store.verifyMigrationDevice(ctx, tx, authority.ownerID, report.OwnerRecipient.DeviceID, frame, binding); err != nil {
		return access.PolicyProof{}, err
	}
	if err := indexApprovedMigrationHistory(ctx, tx, authority, report.MessagePositionsDigest); err != nil {
		return access.PolicyProof{}, err
	}
	genesis, err := store.installMigrationPolicy(ctx, tx, authority, report, signed, binding)
	if err != nil {
		return access.PolicyProof{}, err
	}
	if scopeSignature != nil {
		if err := access.StoreInitialPolicyScopeAttestation(ctx, tx, genesis.Principal, scopeSignature, verifyProtectedPolicyAttestation); err != nil {
			return access.PolicyProof{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return access.PolicyProof{}, err
	}
	return genesis, nil
}

func (s *membershipStore) installMigrationPolicy(ctx context.Context, tx *sql.Tx, authority migrationAuthority,
	report verifiedMigrationImport, signed access.PolicyDraft, binding []byte) (access.PolicyProof, error) {
	var staged bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema
		WHERE name='protected_migration_policy_anchor' AND type='table')`).Scan(&staged); err != nil {
		return access.PolicyProof{}, err
	}
	if staged {
		proof, err := s.readMigrationPolicyAnchor(ctx, tx, authority, report)
		if err != nil {
			return access.PolicyProof{}, err
		}
		if proof.Digest != publicKeyID(signed.Signature) {
			return access.PolicyProof{}, memberError(http.StatusConflict, "MIGRATION_INITIAL_POLICY_CHANGED")
		}
		return proof, nil
	}
	policy, err := readMigrationPolicyDraft(ctx, tx, authority)
	if err != nil {
		return access.PolicyProof{}, err
	}
	format := migrationPolicyFormat{preserveChannelOrder: report.InitialPolicy.PreserveChannelOrder, runtimeRecovery: report.InitialPolicy.RuntimeRecovery}
	initial, actor, err := migrationInitialState(policy, authority.ownerID, *report.OwnerRecipient, format)
	if err != nil {
		return access.PolicyProof{}, err
	}
	proof, err := access.NewStoreWithClock(s.db, s.now).InstallSignedInitialPolicy(ctx, tx, initial, actor, verifyProtectedPolicyDraft, signed)
	if err != nil {
		return access.PolicyProof{}, err
	}
	if _, err := tx.ExecContext(ctx, `CREATE TABLE protected_migration_policy_anchor (
		id INTEGER PRIMARY KEY CHECK(id=1),
		review_digest TEXT NOT NULL CHECK(length(review_digest)=64),
		proof_digest TEXT NOT NULL CHECK(length(proof_digest)=64),
		import_binding BLOB NOT NULL CHECK(length(import_binding)=64)
	) STRICT`); err != nil {
		return access.PolicyProof{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_migration_policy_anchor(id,review_digest,proof_digest,import_binding)
		VALUES(1,?,?,?)`, report.ReviewDigest, proof.Digest, binding)
	return proof, err
}

func (s *membershipStore) readMigrationPolicyAnchor(ctx context.Context, tx *sql.Tx, authority migrationAuthority, report verifiedMigrationImport) (access.PolicyProof, error) {
	var review, digest string
	var binding []byte
	if err := tx.QueryRowContext(ctx, `SELECT review_digest,proof_digest,import_binding FROM protected_migration_policy_anchor WHERE id=1`).
		Scan(&review, &digest, &binding); err != nil {
		return access.PolicyProof{}, err
	}
	proof, err := access.ReadPolicyHead(ctx, tx, nil)
	if err != nil {
		return access.PolicyProof{}, err
	}
	if review != report.ReviewDigest || proof.Digest != digest || proof.Principal.DeviceID != report.OwnerRecipient.DeviceID ||
		proof.Principal.ProfileID != authority.ownerID || proof.Draft.Action != access.AnchorPolicy || proof.Draft.Revision != 1 ||
		proof.Draft.ResultDigest != report.InitialPolicy.Draft.ResultDigest || proof.Draft.OperationID != report.InitialPolicy.Draft.OperationID ||
		proof.Draft.TextProjectionRoot != report.InitialPolicy.Draft.TextProjectionRoot ||
		proof.Draft.TextProjectionSeed != report.InitialPolicy.Draft.TextProjectionSeed ||
		proof.Draft.TextProjectionVersion != report.InitialPolicy.Draft.TextProjectionVersion {
		return access.PolicyProof{}, memberError(http.StatusConflict, "MIGRATION_INITIAL_POLICY_CHANGED")
	}
	if err := verifyProtectedPolicyDraft(ctx, tx, proof.Principal, proof.Draft); err != nil {
		return access.PolicyProof{}, err
	}
	frame, err := migrationPolicyBindingFrame(authority, report, proof.Draft)
	if err != nil {
		return access.PolicyProof{}, err
	}
	return proof, s.verifyMigrationDevice(ctx, tx, authority.ownerID, proof.Principal.DeviceID, frame, binding)
}
