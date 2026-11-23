package access

import (
	"context"
	"database/sql"
	"encoding/json"
)

type PolicyWireProof struct {
	Record         []byte `json:"record"`
	RoleUpdate     []byte `json:"roleUpdate"`
	ResourceChange []byte `json:"resourceChange,omitempty"`
	Snapshot       []byte `json:"snapshot"`
}

type PolicyPage struct {
	HeadRevision          int64               `json:"headRevision"`
	HeadDigest            string              `json:"headDigest"`
	Proofs                []PolicyWireProof   `json:"proofs"`
	Snapshot              []byte              `json:"snapshot,omitempty"`
	GenesisScopeAuthority *ScopeAuthorityLink `json:"genesisScopeAuthority,omitempty"`
}

type PolicyPreview struct {
	Draft                    PolicyDraft `json:"draft"`
	RoleUpdate               []byte      `json:"roleUpdate"`
	ResourceChange           []byte      `json:"resourceChange,omitempty"`
	Snapshot                 []byte      `json:"snapshot,omitempty"`
	ChannelOrderBasis        string      `json:"channelOrderBasis,omitempty"`
	ChannelOrderBasisVersion int         `json:"channelOrderBasisVersion,omitempty"`
}

type policyPageQuery interface {
	SessionQuery
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// PolicyProofPage is an internal projection for verification. It includes the
// full policy, so a public transport needs an explicit visibility contract.
func (s *Store) PolicyProofPage(ctx context.Context, after int64) (PolicyPage, error) {
	return s.PolicyProofPageForSession(ctx, nil, after)
}

func (s *Store) PolicyProofPageForSession(ctx context.Context, resolve ResolveSession, after int64) (PolicyPage, error) {
	var page PolicyPage
	if after < 0 {
		return page, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	if resolve != nil {
		if _, err := resolve(ctx, tx); err != nil {
			return page, err
		}
	}
	return readPolicyPage(ctx, tx, after)
}

func (s State) canInspectFullPolicy(actor Principal) bool {
	return s.hasPolicyDevice(actor) && s.CheckGrant(s.Members[actor.ProfileID], Scope{}, Administrator, 0) == Allowed
}

func (s *Store) DispatchManagementPolicyPage(ctx context.Context, resolve ResolveSession, after int64, deliver func(PolicyPage) error) error {
	if after < 0 {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if !state.canInspectFullPolicy(actor) {
			return MissingGrant
		}
		page, err := readPolicyPage(ctx, conn, after)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(page)
	})
}

func readPolicyPage(ctx context.Context, tx policyPageQuery, after int64) (PolicyPage, error) {
	var page PolicyPage
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return page, err
	}
	head, err := readPolicyHead(ctx, tx)
	if err != nil {
		return page, err
	}
	if head.Digest == "" {
		return page, ErrPolicySignatureRequired
	}
	if err := checkPolicyHead(state, revision, head); err != nil {
		return page, err
	}
	page = PolicyPage{HeadRevision: revision, HeadDigest: head.Digest, Proofs: []PolicyWireProof{}}
	page.GenesisScopeAuthority, err = ReadGenesisScopeAuthority(ctx, tx)
	if err != nil {
		return PolicyPage{}, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT record,snapshot FROM protected_policy_proofs WHERE revision>? ORDER BY revision LIMIT 32", after)
	if err != nil {
		return PolicyPage{}, err
	}
	defer rows.Close()
	bytes := 0
	for rows.Next() {
		var raw, snapshot []byte
		var proof PolicyProof
		if err := rows.Scan(&raw, &snapshot); err != nil {
			return PolicyPage{}, err
		}
		if err := json.Unmarshal(raw, &proof); err != nil {
			return PolicyPage{}, err
		}
		roleUpdate, err := json.Marshal(proof.Draft.RoleUpdate)
		if err != nil {
			return PolicyPage{}, err
		}
		var resourceChange []byte
		if proof.Draft.ResourceChange != nil {
			resourceChange, err = json.Marshal(proof.Draft.ResourceChange)
			if err != nil {
				return PolicyPage{}, err
			}
		}
		size := len(raw) + len(roleUpdate) + len(resourceChange) + len(snapshot)
		if bytes+size > 8<<20 {
			if len(page.Proofs) == 0 {
				return PolicyPage{}, InvalidPolicy
			}
			break
		}
		bytes += size
		page.Proofs = append(page.Proofs, PolicyWireProof{Record: raw, RoleUpdate: roleUpdate, ResourceChange: resourceChange, Snapshot: snapshot})
	}
	if err := rows.Err(); err != nil {
		return PolicyPage{}, err
	}
	if after == revision {
		page.Snapshot, err = state.policySnapshotBytes()
	}
	return page, err
}
