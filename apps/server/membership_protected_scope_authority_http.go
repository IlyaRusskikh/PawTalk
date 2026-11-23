package main

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

const scopeAuthorityPageSize = 32

func (p *protectedRuntime) acceptScopeDeviceHandoverHTTP(w http.ResponseWriter, r *http.Request) {
	var input access.ScopeAuthorityLink
	if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
		memberFail(w, err)
		return
	}
	var key []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		memberFail(w, err)
		return
	}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitScopeDeviceHandover(r.Context(), p.resolveSession(memberBearer(r)),
		input, p.cutoverDigest, b64.EncodeToString(key), signProtectedServerPolicy, verifyProtectedPolicyDraft)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"operationId": proof.Draft.OperationID, "revision": proof.Draft.Revision, "digest": proof.Digest})
}

func verifyProtectedScopeDeviceHandover(ctx context.Context, query access.SessionQuery, actor access.Principal, draft access.PolicyDraft) error {
	reader, ok := query.(access.ScopeAuthorityQuery)
	if !ok || draft.ResourceChange == nil || draft.ResourceChange.ScopeDeviceHandover == nil {
		return access.ErrScopeAuthority
	}
	var serverID string
	if err := reader.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	return access.VerifyScopeDeviceHandover(ctx, reader, serverID, draft.ResourceChange.ScopeDeviceHandover.CutoverDigest, actor, draft)
}

func verifyRuntimeRecoveryScopeAuthority(ctx context.Context, query access.SessionQuery, serverID, cutover string,
	actor access.Principal, draft access.PolicyDraft) error {
	reader, ok := query.(access.ScopeAuthorityQuery)
	if !ok {
		return access.ErrPolicyConflict
	}
	return access.VerifyRecoveryScopeAuthority(ctx, reader, serverID, cutover, actor, draft)
}

func (p *protectedRuntime) scopeAuthorityHTTP(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	through, err := strconv.ParseInt(query.Get("through"), 10, 64)
	if err != nil || through < 1 || through > migrationMaxSafePosition {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var after int64
	if raw := query.Get("after"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || after < 0 || after > migrationMaxSafePosition {
			protectedPolicyFail(w, access.InvalidAction)
			return
		}
	}
	ctx := r.Context()
	tx, err := p.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	defer tx.Rollback()
	head, err := access.ReadPolicyHead(ctx, tx, nil)
	if err == nil && through > head.Draft.Revision {
		err = access.ErrPolicyConflict
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	proofs, authority, err := access.ReadScopeAuthorityProofs(ctx, tx, p.serverID, p.cutoverDigest, through)
	if err == nil && after > authority.Sequence {
		err = access.ErrPolicyConflict
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	end := min(after+scopeAuthorityPageSize, authority.Sequence)
	respond(w, http.StatusOK, struct {
		GenesisDeviceKey string                      `json:"genesisDeviceKey"`
		Links            []access.ScopeAuthorityLink `json:"links"`
		HeadSequence     int64                       `json:"headSequence"`
		HeadDigest       string                      `json:"headDigest"`
	}{proofs.GenesisDeviceKey, proofs.Links[after:end], authority.Sequence, authority.Digest})
}
