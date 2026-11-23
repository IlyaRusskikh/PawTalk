package access

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
)

const policyAttestationSchema = `CREATE TABLE IF NOT EXISTS protected_policy_attestations (
	revision INTEGER PRIMARY KEY REFERENCES protected_policy_proofs(revision),
	signature BLOB NOT NULL CHECK(length(signature)=64)
) STRICT;
CREATE TABLE IF NOT EXISTS protected_policy_attestations_v2 (
	revision INTEGER PRIMARY KEY REFERENCES protected_policy_proofs(revision),
	authority_revision INTEGER NOT NULL REFERENCES protected_policy_proofs(revision) CHECK(authority_revision>1),
	authority_head TEXT NOT NULL CHECK(length(authority_head)=64),
	signer_device_id TEXT NOT NULL CHECK(length(signer_device_id)=64),
	signature BLOB NOT NULL CHECK(length(signature)=64)
) STRICT;
CREATE INDEX IF NOT EXISTS protected_scope_authority_revisions_v2 ON protected_policy_proofs(revision) WHERE ` + scopeAuthorityProofPredicate + `;`

func EnsurePolicyAttestationSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, policyAttestationSchema)
	return err
}

var ErrPolicyAttestationUnavailable = errors.New("protected policy attestation unavailable")

type PolicyAttestation struct {
	Revision          int64  `json:"revision"`
	Digest            string `json:"digest"`
	Previous          string `json:"previous"`
	PolicyDigest      string `json:"policyDigest"`
	Root              string `json:"root"`
	SignerKey         string `json:"signerKey"`
	Signature         []byte `json:"signature"`
	ProjectionVersion int    `json:"projectionVersion,omitempty"`
	AuthorityHead     string `json:"authorityHead,omitempty"`
	AuthorityRevision int64  `json:"authorityRevision,omitempty"`
	SignerDeviceID    string `json:"signerDeviceId,omitempty"`
	SignerProfileID   string `json:"signerProfileId,omitempty"`
}

type PendingPolicyAttestations struct {
	HeadRevision      int64   `json:"headRevision"`
	HeadDigest        string  `json:"headDigest"`
	Revisions         []int64 `json:"revisions"`
	AuthorityHead     string  `json:"authorityHead,omitempty"`
	AuthorityRevision int64   `json:"authorityRevision,omitempty"`
	SignerDeviceID    string  `json:"signerDeviceId,omitempty"`
	SignerProfileID   string  `json:"signerProfileId,omitempty"`
}

type ScopeAuthorityBinding struct {
	ServerID      string
	CutoverDigest string
}

func (s *Store) DispatchPendingPolicyAttestations(ctx context.Context, resolve ResolveSession,
	deliver func(PendingPolicyAttestations) error, bindings ...ScopeAuthorityBinding) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || state.Owner != actor.ProfileID || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
			return MissingGrant
		}
		anchor, err := readAttestedProof(ctx, conn, 1)
		if err != nil {
			return err
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		authority, err := readPolicyAttestationAuthority(ctx, conn, head.Draft.Revision, bindings)
		if err != nil {
			return err
		}
		if actor != policyAttestationSigner(anchor, authority) {
			return MissingGrant
		}
		pending := PendingPolicyAttestations{HeadRevision: head.Draft.Revision, HeadDigest: head.Digest, Revisions: make([]int64, 0, 4)}
		if usesTransferredPolicyAttestation(anchor, authority) {
			pending.AuthorityHead, pending.AuthorityRevision, pending.SignerDeviceID = authority.Digest, authority.Revision, authority.DeviceID
			if authority.OwnershipTransferred {
				pending.SignerProfileID = authority.OwnerProfileID
			}
		}
		rows, err := conn.QueryContext(ctx, `SELECT p.revision FROM protected_policy_proofs p
			WHERE json_extract(CAST(p.record AS TEXT), '$.Draft.TextProjectionVersion') BETWEEN ? AND ?
			AND NOT EXISTS (SELECT 1 FROM protected_policy_attestations a WHERE a.revision=p.revision)
			AND NOT EXISTS (SELECT 1 FROM protected_policy_attestations_v2 a WHERE a.revision=p.revision)
			ORDER BY (p.revision=?) DESC,p.revision LIMIT 4`,
			TextRecipientProjectionVersion, ProfileRoleAuthorityProjectionVersion, pending.HeadRevision)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var revision int64
			if err := rows.Scan(&revision); err != nil {
				return err
			}
			pending.Revisions = append(pending.Revisions, revision)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		slices.Sort(pending.Revisions)
		return deliver(pending)
	})
}

func PolicyAttestationFrame(serverID, anchorDigest string, signer Principal, view PolicyAttestation) ([]byte, error) {
	version := view.ProjectionVersion
	if version == 0 {
		version = TextRecipientProjectionVersion
	}
	fields := []string{"pawtalk-policy-scope-attestation-v1", serverID, anchorDigest, signer.ProfileID, signer.DeviceID,
		strconv.FormatInt(view.Revision, 10), view.Digest, view.Previous, view.PolicyDigest, strconv.Itoa(version), view.Root}
	if view.AuthorityHead != "" || view.AuthorityRevision != 0 || view.SignerDeviceID != "" || view.SignerProfileID != "" {
		if !isDigest(view.AuthorityHead) || view.AuthorityRevision < 2 || view.AuthorityRevision > maxScopeAuthorityRevision ||
			!isDigest(view.SignerDeviceID) || view.SignerDeviceID != signer.DeviceID ||
			(view.SignerProfileID != "" && view.SignerProfileID != signer.ProfileID) {
			return nil, ErrScopeAuthority
		}
		fields[0] = "pawtalk-policy-scope-attestation-v2"
		fields = append(fields, view.AuthorityHead, strconv.FormatInt(view.AuthorityRevision, 10))
	}
	return SignatureFrame(fields...)
}

type VerifyPolicyAttestation func(context.Context, SessionQuery, Principal, string, PolicyAttestation) error

func readPolicyAttestationAuthority(ctx context.Context, query ScopeAuthorityQuery, revision int64,
	bindings []ScopeAuthorityBinding) (ScopeAuthorityState, error) {
	if len(bindings) == 0 {
		return ScopeAuthorityState{}, nil
	}
	if len(bindings) != 1 {
		return ScopeAuthorityState{}, ErrScopeAuthority
	}
	binding := bindings[0]
	_, authority, err := ReadScopeAuthorityProofs(ctx, query, binding.ServerID, binding.CutoverDigest, revision)
	return authority, err
}

func policyAttestationSigner(anchor PolicyProof, authority ScopeAuthorityState) Principal {
	signer := anchor.Principal
	if authority.DeviceID != "" {
		signer = Principal{ProfileID: authority.OwnerProfileID, DeviceID: authority.DeviceID}
	}
	return signer
}

func usesTransferredPolicyAttestation(anchor PolicyProof, authority ScopeAuthorityState) bool {
	return authority.OwnershipTransferred || authority.SignerMoved || policyAttestationSigner(anchor, authority) != anchor.Principal
}

func readAttestedProof(ctx context.Context, query SessionQuery, revision int64) (PolicyProof, error) {
	return readStoredPolicyProof(ctx, query, query.QueryRowContext(ctx, `SELECT revision,operation_id,digest,record
		FROM protected_policy_proofs WHERE revision=?`, revision))
}

func readAttestation(ctx context.Context, query SessionQuery, revision int64) (PolicyAttestation, PolicyProof, error) {
	var view PolicyAttestation
	anchor, err := readAttestedProof(ctx, query, 1)
	if err != nil {
		return view, anchor, err
	}
	proof, err := readAttestedProof(ctx, query, revision)
	if errors.Is(err, sql.ErrNoRows) {
		return view, anchor, ErrPolicyAttestationUnavailable
	}
	if err != nil {
		return view, anchor, err
	}
	if !HasTextRecipientProjection(proof.Draft.TextProjectionVersion) || !isDigest(proof.Draft.TextProjectionRoot) {
		return view, anchor, ErrPolicyAttestationUnavailable
	}
	var raw []byte
	if err := query.QueryRowContext(ctx, "SELECT snapshot FROM protected_policy_proofs WHERE revision=1").Scan(&raw); err != nil {
		return view, anchor, err
	}
	var initial struct {
		Owner         string
		PolicyDevices map[string]PolicyDevice
	}
	if err := json.Unmarshal(raw, &initial); err != nil || hexHash(raw) != anchor.Draft.ResultDigest || initial.Owner != anchor.Principal.ProfileID {
		return view, anchor, ErrPolicyConflict
	}
	signer := initial.PolicyDevices[anchor.Principal.DeviceID]
	if signer.Revoked || signer.ProfileID != initial.Owner || !signingKeyMatches(anchor.Principal.DeviceID, signer.PublicKey) {
		return view, anchor, ErrPolicyConflict
	}
	view = PolicyAttestation{Revision: revision, Digest: proof.Digest, Previous: proof.Draft.PreviousDigest,
		PolicyDigest: proof.Draft.ResultDigest, Root: proof.Draft.TextProjectionRoot, SignerKey: signer.PublicKey}
	if proof.Draft.TextProjectionVersion >= TextRevisionProjectionVersion {
		view.ProjectionVersion = proof.Draft.TextProjectionVersion
	}
	return view, anchor, nil
}

func (s *Store) CommitPolicyAttestation(ctx context.Context, resolve ResolveSession, verify VerifyPolicyAttestation,
	revision int64, signature []byte, bindings ...ScopeAuthorityBinding) error {
	if revision < 1 || len(signature) != 64 || verify == nil {
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
	state, current, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	if !state.PolicyAnchored || state.Owner != actor.ProfileID || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
		return MissingGrant
	}
	if revision > current {
		return ErrPolicyConflict
	}
	authority, err := readPolicyAttestationAuthority(ctx, tx, current, bindings)
	if err != nil {
		return err
	}
	if err := storePolicyAttestationWithAuthority(ctx, tx, verify, actor, revision, signature, authority); err != nil {
		return err
	}
	return tx.Commit()
}

func storePolicyAttestation(ctx context.Context, tx *sql.Tx, verify VerifyPolicyAttestation,
	actor Principal, revision int64, signature []byte) error {
	return storePolicyAttestationWithAuthority(ctx, tx, verify, actor, revision, signature, ScopeAuthorityState{})
}

func storePolicyAttestationWithAuthority(ctx context.Context, tx *sql.Tx, verify VerifyPolicyAttestation,
	actor Principal, revision int64, signature []byte, authority ScopeAuthorityState) error {
	view, anchor, err := readAttestation(ctx, tx, revision)
	if err != nil {
		return err
	}
	if actor != policyAttestationSigner(anchor, authority) {
		return MissingGrant
	}
	if usesTransferredPolicyAttestation(anchor, authority) {
		view.AuthorityHead, view.AuthorityRevision, view.SignerDeviceID = authority.Digest, authority.Revision, authority.DeviceID
		if authority.OwnershipTransferred {
			view.SignerProfileID = authority.OwnerProfileID
		}
		view.SignerKey = authority.DeviceKey
	}
	view.Signature = signature
	if err := verify(ctx, tx, actor, anchor.Digest, view); err != nil {
		return err
	}
	if view.AuthorityRevision != 0 {
		return storeTransferredPolicyAttestation(ctx, tx, view)
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO protected_policy_attestations(revision,signature) VALUES(?,?)`, revision, signature); err != nil {
		return err
	}
	var existing []byte
	if err := tx.QueryRowContext(ctx, "SELECT signature FROM protected_policy_attestations WHERE revision=?", revision).Scan(&existing); err != nil {
		return err
	}
	if !bytes.Equal(existing, signature) {
		return ErrPolicyConflict
	}
	return nil
}

func storeTransferredPolicyAttestation(ctx context.Context, tx *sql.Tx, view PolicyAttestation) error {
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO protected_policy_attestations_v2
		(revision,authority_revision,authority_head,signer_device_id,signature) SELECT ?,?,?,?,?
		WHERE NOT EXISTS (SELECT 1 FROM protected_policy_attestations WHERE revision=?)`,
		view.Revision, view.AuthorityRevision, view.AuthorityHead, view.SignerDeviceID, view.Signature, view.Revision); err != nil {
		return err
	}
	var existing PolicyAttestation
	err := tx.QueryRowContext(ctx, `SELECT authority_revision,authority_head,signer_device_id,signature
		FROM protected_policy_attestations_v2 WHERE revision=?`, view.Revision).
		Scan(&existing.AuthorityRevision, &existing.AuthorityHead, &existing.SignerDeviceID, &existing.Signature)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (existing.AuthorityRevision != view.AuthorityRevision ||
		existing.AuthorityHead != view.AuthorityHead || existing.SignerDeviceID != view.SignerDeviceID ||
		!bytes.Equal(existing.Signature, view.Signature))) {
		return ErrPolicyConflict
	}
	return err
}

// StoreInitialPolicyScopeAttestation attaches a verified attestation to the
// genesis proof in the caller's bootstrap transaction.
func StoreInitialPolicyScopeAttestation(ctx context.Context, tx *sql.Tx, actor Principal, signature []byte, verify VerifyPolicyAttestation) error {
	if len(signature) != 64 || verify == nil {
		return InvalidAction
	}
	return storePolicyAttestation(ctx, tx, verify, actor, 1, signature)
}

func (s *Store) DispatchPolicyAttestation(ctx context.Context, resolve ResolveSession, verify VerifyPolicyAttestation,
	revision int64, deliver func(PolicyAttestation) error, bindings ...ScopeAuthorityBinding) error {
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.Members[actor.ProfileID].Active {
			return MissingGrant
		}
		head, err := ReadPolicyHead(ctx, conn, &actor)
		if err != nil {
			return err
		}
		target := revision
		if target == 0 {
			target = head.Draft.Revision
		}
		view, anchor, err := readAttestation(ctx, conn, target)
		if err != nil {
			return err
		}
		signer, err := readPolicyAttestationSignature(ctx, conn, target, head.Draft.Revision, &view, anchor, bindings)
		if err != nil {
			return err
		}
		if target == head.Draft.Revision && !state.hasPolicyDevice(signer) {
			return ErrPolicyAttestationUnavailable
		}
		if err := verify(ctx, conn, signer, anchor.Digest, view); err != nil {
			return err
		}
		return deliver(view)
	})
}

func readPolicyAttestationSignature(ctx context.Context, conn ScopeAuthorityQuery, target, current int64,
	view *PolicyAttestation, anchor PolicyProof, bindings []ScopeAuthorityBinding) (Principal, error) {
	err := conn.QueryRowContext(ctx, "SELECT signature FROM protected_policy_attestations WHERE revision=?", target).Scan(&view.Signature)
	if errors.Is(err, sql.ErrNoRows) {
		err = conn.QueryRowContext(ctx, `SELECT authority_revision,authority_head,signer_device_id,signature
			FROM protected_policy_attestations_v2 WHERE revision=?`, target).
			Scan(&view.AuthorityRevision, &view.AuthorityHead, &view.SignerDeviceID, &view.Signature)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return Principal{}, ErrPolicyAttestationUnavailable
	}
	if err != nil {
		return Principal{}, err
	}
	if view.AuthorityRevision > current {
		return Principal{}, ErrPolicyConflict
	}
	through := max(target, view.AuthorityRevision)
	authority, err := readPolicyAttestationAuthority(ctx, conn, through, bindings)
	if err != nil {
		return Principal{}, err
	}
	signer := policyAttestationSigner(anchor, authority)
	if view.AuthorityRevision == 0 {
		if usesTransferredPolicyAttestation(anchor, authority) {
			return Principal{}, ErrPolicyAttestationUnavailable
		}
		return signer, nil
	}
	if !usesTransferredPolicyAttestation(anchor, authority) || view.AuthorityRevision != authority.Revision || view.AuthorityHead != authority.Digest ||
		view.SignerDeviceID != authority.DeviceID {
		return Principal{}, ErrPolicyAttestationUnavailable
	}
	view.SignerKey = authority.DeviceKey
	if authority.OwnershipTransferred {
		view.SignerProfileID = authority.OwnerProfileID
	}
	return signer, nil
}
