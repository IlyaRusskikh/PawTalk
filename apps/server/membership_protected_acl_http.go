package main

import (
	"bytes"
	"encoding/json"
	"net/http"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) channelACLProofHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchChannelACL(r.Context(),
		p.resolveSession(memberBearer(r)), channel, &p.textPolicyProofs, func(proof access.ChannelACLDisclosure) error {
			return writeProtectedDelivery(w, &sent, proof)
		})
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) channelACLPersonalHTTP(w http.ResponseWriter, r *http.Request) {
	channel, profile := r.PathValue("channel"), r.PathValue("profile")
	if !validHexID(channel, 32) || !validHexID(profile, 64) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var sent bool
	err := access.NewStoreWithClock(p.store.db, p.store.now).DispatchChannelACLPersonal(r.Context(),
		p.resolveSession(memberBearer(r)), channel, profile, &p.textPolicyProofs, func(proof access.ChannelACLPersonalDisclosure) error {
			return writeProtectedDelivery(w, &sent, proof)
		})
	if err != nil && !sent {
		policyAttestationFail(w, err)
	}
}

func (p *protectedRuntime) commitChannelACLPersonalHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var input struct {
		OperationID     string `json:"operationId"`
		PolicyHead      string `json:"policyHead"`
		TargetProfileID string `json:"targetProfileId"`
		Permission      string `json:"permission"`
		Rule            string `json:"rule"`
		EditorProof     string `json:"editorProof"`
	}
	if _, err := decodeMemberJSON(w, r, 4096, &input); err != nil {
		memberFail(w, err)
		return
	}
	if !validHexID(input.TargetProfileID, 64) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var key []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		memberFail(w, err)
		return
	}
	draft := access.PolicyDraft{Action: access.EditScopedChannelACLPersonal, OperationID: input.OperationID,
		PreviousDigest: input.PolicyHead, ResourceChange: &access.PolicyResourceChange{
			ID: channel, TargetProfileID: input.TargetProfileID, ACLPersonalEdit: &access.PolicyChannelACLPersonalEdit{
				CutoverDigest: p.cutoverDigest, Permission: input.Permission, Rule: input.Rule,
				EditorProof: input.EditorProof, ServerKey: b64.EncodeToString(key),
			}}}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitScopedChannelACLPersonalEdit(r.Context(),
		p.resolveSession(memberBearer(r)), draft, signProtectedServerPolicy, verifyProtectedPolicyDraft)
	if err != nil {
		policyAttestationFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"operationId": proof.Draft.OperationID, "revision": proof.Draft.Revision, "digest": proof.Digest})
}

func (p *protectedRuntime) commitChannelACLRoleRulesHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	if !validHexID(channel, 32) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var input struct {
		OperationID         string          `json:"operationId"`
		PolicyHead          string          `json:"policyHead"`
		PreviousRulesDigest string          `json:"previousRulesDigest"`
		Rules               json.RawMessage `json:"rules"`
		EditorProof         string          `json:"editorProof"`
	}
	if _, err := decodeMemberJSON(w, r, 1<<20, &input); err != nil {
		memberFail(w, err)
		return
	}
	var rules map[string]access.Overwrite
	if err := json.Unmarshal(input.Rules, &rules); err != nil || rules == nil {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	canonical, err := json.Marshal(rules)
	if err != nil {
		memberFail(w, err)
		return
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, input.Rules); err != nil || !bytes.Equal(compact.Bytes(), canonical) {
		protectedPolicyFail(w, access.InvalidAction)
		return
	}
	var key []byte
	if err := p.store.db.QueryRowContext(r.Context(), "SELECT identity_public_key FROM server_state WHERE id=1").Scan(&key); err != nil {
		memberFail(w, err)
		return
	}
	draft := access.PolicyDraft{Action: access.EditScopedChannelACLRoleRules, OperationID: input.OperationID,
		PreviousDigest: input.PolicyHead, ResourceChange: &access.PolicyResourceChange{ID: channel,
			ACL: &access.ACL{Roles: rules}, ACLRoleEdit: &access.PolicyChannelACLRoleEdit{
				CutoverDigest: p.cutoverDigest, PreviousRulesDigest: input.PreviousRulesDigest, EditorProof: input.EditorProof,
				ServerKey: b64.EncodeToString(key),
			}}}
	proof, err := access.NewStoreWithClock(p.store.db, p.store.now).CommitScopedChannelACLRoleRulesEdit(r.Context(),
		p.resolveSession(memberBearer(r)), draft, signProtectedServerPolicy, verifyProtectedPolicyDraft)
	if err != nil {
		policyAttestationFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"operationId": proof.Draft.OperationID, "revision": proof.Draft.Revision, "digest": proof.Digest})
}
