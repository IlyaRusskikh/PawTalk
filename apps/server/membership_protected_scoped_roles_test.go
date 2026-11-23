package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"slices"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedScopedRoleReadsAndPreviewTLS(t *testing.T) {
	for _, version := range []int{access.TextNewcomerAdmissionProjectionVersion, access.ProfileRoleAuthorityProjectionVersion} {
		t.Run(fmt.Sprintf("v%d", version), func(t *testing.T) { testProtectedScopedRoleReadsAndPreviewTLS(t, version) })
	}
}

func testProtectedScopedRoleReadsAndPreviewTLS(t *testing.T, version int) {
	t.Helper()
	ctx := context.Background()
	server := testMembershipStore(t)
	visibleChannel, hiddenChannel, effectChannel := strings.Repeat("a", 32), strings.Repeat("b", 32), strings.Repeat("d", 32)
	var editor, visibleTarget, hiddenTarget memberSession
	store, initial, owner, assigner := protectedTestStateWith(t, server, func(state *access.State) {
		enroll := func(seed byte, role string) memberSession {
			t.Helper()
			identity := newTestMemberSigner(seed)
			activateTestMember(t, server, identity, "member")
			login := loginTestMember(t, server, identity)
			profile, device := login.Access.EffectiveProfileID, login.Access.DeviceID
			state.Members[profile] = access.Subject{ID: profile, Active: true, Roles: []string{role}}
			state.PolicyDevices[device] = access.PolicyDevice{ProfileID: profile, PublicKey: testSigningKey(seed)}
			state.KeyRecipients[device] = access.KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: testRecipientKey(t, seed+40)}
			return login
		}
		state.Roles = map[string]access.Role{
			access.Everyone: {Grants: []string{access.ChannelView}},
			"reader":        {Grants: []string{"role.assign"}},
			"editor":        {Grants: []string{"role.edit"}},
			"label":         {},
			"other":         {},
			"privileged":    {Grants: []string{"member.list"}},
			"higher":        {},
		}
		state.Order = []string{"label", "other", "privileged", "reader", "editor", "higher"}
		state.RolePresentation = map[string]access.RolePresentation{"higher": {Name: "Above the editor"}}
		editor, visibleTarget, hiddenTarget = enroll(3, "editor"), enroll(4, "label"), enroll(5, "label")
		state.Channels = map[string]access.Channel{
			visibleChannel: {Kind: "text", NextPosition: 1, ACL: access.ACL{Profiles: map[string]access.Overwrite{
				hiddenTarget.Access.EffectiveProfileID: {Deny: []string{access.ChannelView}},
			}}},
			hiddenChannel: {Kind: "text", NextPosition: 1, ACL: access.ACL{Roles: map[string]access.Overwrite{
				access.Everyone: {Deny: []string{access.ChannelView}},
			}}},
			effectChannel: {Kind: "text", NextPosition: 1, ACL: access.ACL{Roles: map[string]access.Overwrite{
				"label": {Deny: []string{access.ChannelView}},
			}}},
		}
	})
	anchor, runtime, open, call := openScopedACLFixture(t, ctx, server, store, owner, version)
	ownerToken, assignerToken, editorToken := open(owner, 1), open(assigner, 2), open(editor, 3)
	const roleRoute = "/api/v3/roles/scoped"
	// The owner can assign the ban grant but its rank class belongs to
	// the compiled policy catalog, outside the editable role schema.
	rejected := call(http.MethodPost, "/api/v3/policy/preview", ownerToken, []byte(fmt.Sprintf(`{
		"Action":%q, "OperationID":"abcdabcdabcdabcdabcdabcdabcdabcd",
		"RoleUpdate":{"Roles":{"reader":{"Grants":["member.ban"],"Rank":"unranked"}},"Order":["reader"]}
	}`, access.UpdatePolicyRoles)), http.StatusBadRequest)
	if !bytes.Contains(rejected, []byte(`"code":"INVALID_JSON"`)) {
		t.Fatalf("rank-class edit was not rejected by the schema: %s", rejected)
	}
	target := visibleTarget.Access.EffectiveProfileID
	assignmentQuery := "?channel=" + visibleChannel + "&profile=" + target
	read := func(token, path string, status int) []byte {
		t.Helper()
		return call(http.MethodGet, path, token, nil, status)
	}
	for _, item := range []struct {
		token        string
		assign, edit bool
	}{{assignerToken, true, false}, {editorToken, false, true}} {
		var projection access.Projection
		if err := json.Unmarshal(read(item.token, "/api/v3/state", http.StatusOK), &projection); err != nil ||
			projection.CanAssignRoles != item.assign || projection.CanEditRoles != item.edit || projection.CanInspectPolicy {
			t.Fatalf("scoped role controls did not reflect independent capabilities: %+v, %v", projection, err)
		}
	}
	var roster access.RosterPage
	if err := json.Unmarshal(read(assignerToken, "/api/v3/roster/text/"+visibleChannel, http.StatusOK), &roster); err != nil {
		t.Fatal(err)
	}
	for _, member := range roster.Members {
		if member.CanAssignRoles != (member.ID == target) {
			t.Fatalf("unexpected assignment control for roster member %s: %v", member.ID, member.CanAssignRoles)
		}
	}
	var assignmentBasis access.ScopedRoleBasis
	assignmentBody := read(assignerToken, roleRoute+assignmentQuery, http.StatusOK)
	if err := json.Unmarshal(assignmentBody, &assignmentBasis); err != nil {
		t.Fatal(err)
	}
	wantOptions := []access.ScopedRoleOption{{ID: "label", Assigned: true, CanAssign: true}, {ID: "other", CanAssign: true}}
	if assignmentBasis.Assignments == nil || !slices.Equal(*assignmentBasis.Assignments, wantOptions) ||
		assignmentBasis.Definitions != nil || assignmentBasis.PolicyHead != anchor.Digest || assignmentBasis.TargetProfile != target {
		t.Fatalf("assignment basis = %s", assignmentBody)
	}
	read(assignerToken, roleRoute, http.StatusForbidden)
	read(editorToken, roleRoute+assignmentQuery, http.StatusForbidden)
	read(assignerToken, roleRoute+"?profile="+target, http.StatusForbidden)
	read(assignerToken, "/api/v3/policy/proofs?after=0", http.StatusForbidden)
	hidden := read(assignerToken, roleRoute+"?channel="+visibleChannel+"&profile="+hiddenTarget.Access.EffectiveProfileID, http.StatusForbidden)
	unknown := read(assignerToken, roleRoute+"?channel="+visibleChannel+"&profile="+strings.Repeat("e", 64), http.StatusForbidden)
	if !bytes.Equal(hidden, unknown) {
		t.Fatalf("hidden profile response differed from an unknown profile: %s vs %s", hidden, unknown)
	}
	var definitionBasis access.ScopedRoleBasis
	definitionBody := read(editorToken, roleRoute, http.StatusOK)
	if err := json.Unmarshal(definitionBody, &definitionBasis); err != nil {
		t.Fatal(err)
	}
	if definitionBasis.Definitions == nil || definitionBasis.Assignments != nil ||
		bytes.Contains(definitionBody, []byte("Above the editor")) || bytes.Contains(definitionBody, []byte(hiddenChannel)) ||
		bytes.Contains(definitionBody, []byte(hiddenTarget.Access.EffectiveProfileID)) {
		t.Fatalf("definition basis = %s", definitionBody)
	}
	preview := func(token string, change access.ScopedRoleChange, status int) []byte {
		t.Helper()
		input, err := json.Marshal(change)
		if err != nil {
			t.Fatal(err)
		}
		return call(http.MethodPost, roleRoute+"/preview", token, input, status)
	}
	assignment := access.ScopedRoleChange{Revision: anchor.Draft.Revision, PolicyHead: anchor.Digest,
		TargetProfile: target, RosterChannel: visibleChannel, Add: []string{"other"}, Remove: []string{"label"}}
	assignmentPreview := preview(assignerToken, assignment, http.StatusOK)
	var fields map[string]json.RawMessage
	wantFields := 3
	if version == access.ProfileRoleAuthorityProjectionVersion {
		wantFields++
	}
	if err := json.Unmarshal(assignmentPreview, &fields); err != nil || len(fields) != wantFields ||
		fields["revision"] == nil || fields["policyHead"] == nil || (wantFields == 4 && fields["rosterSalt"] == nil) {
		t.Fatalf("preview exposed policy or metadata: %s", assignmentPreview)
	}
	var impacts []access.ScopedRoleChannelImpact
	if err := json.Unmarshal(fields["channels"], &impacts); err != nil ||
		!slices.Equal(impacts, []access.ScopedRoleChannelImpact{{ID: effectChannel, ViewAdded: 1, KeyUpdate: true}}) ||
		bytes.Contains(assignmentPreview, []byte(hiddenChannel)) || bytes.Contains(assignmentPreview, []byte(target)) {
		t.Fatalf("preview failed to scope access and rotation effects: %s", assignmentPreview)
	}
	preview(editorToken, assignment, http.StatusForbidden)
	for _, forbiddenRole := range []string{"privileged", "editor"} {
		forbidden := assignment
		forbidden.Add = []string{forbiddenRole}
		preview(assignerToken, forbidden, http.StatusForbidden)
	}
	definitions := []access.ScopedRoleDefinition{{ID: "new", Grants: []string{}}}
	edit := access.ScopedRoleChange{Revision: anchor.Draft.Revision, PolicyHead: anchor.Digest, Definitions: &definitions}
	preview(editorToken, edit, http.StatusOK)
	preview(assignerToken, edit, http.StatusForbidden)
	incompleteOrder := []string{"new"}
	edit.Order = &incompleteOrder
	preview(editorToken, edit, http.StatusForbidden)
	editableOrder := []string{"other", "label", "privileged", "reader", "new"}
	edit.Order = &editableOrder
	preview(editorToken, edit, http.StatusOK)
	deleteRole := access.ScopedRoleChange{Revision: anchor.Draft.Revision, PolicyHead: anchor.Digest, Delete: []string{"label"}}
	var deletion access.ScopedRolePreview
	if err := json.Unmarshal(preview(editorToken, deleteRole, http.StatusOK), &deletion); err != nil ||
		!slices.Equal(deletion.Channels, []access.ScopedRoleChannelImpact{{ID: effectChannel, ViewAdded: 2, KeyUpdate: true}}) {
		t.Fatalf("preview did not account for removing the role deny: %+v, %v", deletion, err)
	}
	if after := read(assignerToken, roleRoute+assignmentQuery, http.StatusOK); !bytes.Equal(assignmentBody, after) {
		t.Fatalf("preview changed role state: before %s, after %s", assignmentBody, after)
	}
	ownerChange := access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("2", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order,
			Presentation: map[string]access.RolePresentation{"other": {Name: "Changed between previews"}}}}
	encode := func(value any) []byte {
		t.Helper()
		result, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	var ownerPreview access.PolicyPreview
	fullAssignment := access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat("f", 32),
		RoleUpdate: &access.RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order,
			Assignments: map[string][]string{target: {"other"}}}}
	call(http.MethodPost, "/api/v3/policy/preview", assignerToken, encode(fullAssignment), http.StatusForbidden)
	if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", ownerToken, encode(fullAssignment), http.StatusOK), &ownerPreview); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, "/api/v3/policy/commit", assignerToken,
		encode(signTestPolicyDraft(t, server, assigner, 2, ownerPreview.Draft)), http.StatusForbidden)
	if err := json.Unmarshal(call(http.MethodPost, "/api/v3/policy/preview", ownerToken, encode(ownerChange), http.StatusOK), &ownerPreview); err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, "/api/v3/policy/commit", ownerToken,
		encode(signTestPolicyDraft(t, server, owner, 1, ownerPreview.Draft)), http.StatusOK)
	preview(assignerToken, assignment, http.StatusConflict)

	signedEdit := func(member memberSession, seed byte, id string, change access.ScopedRoleChange) string {
		t.Helper()
		actor := access.Principal{ProfileID: member.Access.EffectiveProfileID, DeviceID: member.Access.DeviceID}
		frame, err := access.ScopedRoleEditFrame(runtime.serverID, actor, id, access.ScopedRoleEdit{Change: change, CutoverDigest: runtime.cutoverDigest})
		if err != nil {
			t.Fatal(err)
		}
		return b64.EncodeToString(ed25519.Sign(newTestMemberSigner(seed).device, frame))
	}
	const commitRoute = roleRoute + "/commit"
	commit := func(token, id string, change access.ScopedRoleChange, signature string, status int) []byte {
		t.Helper()
		return call(http.MethodPost, commitRoute, token, encode(map[string]any{"operationId": id, "change": change, "signature": signature}), status)
	}
	assignID := strings.Repeat("3", 32)
	commit(assignerToken, assignID, assignment, signedEdit(assigner, 2, assignID, assignment), http.StatusConflict)
	assignment.Revision, assignment.PolicyHead = ownerPreview.Draft.Revision, ""
	current, err := access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	assignment.PolicyHead = current.Digest
	if version == access.ProfileRoleAuthorityProjectionVersion {
		var reviewed access.ScopedRolePreview
		if err := json.Unmarshal(preview(assignerToken, assignment, http.StatusOK), &reviewed); err != nil || len(reviewed.RosterSalt) != 64 {
			t.Fatalf("v18 preview did not return a roster salt: %+v / %v", reviewed, err)
		}
		frame, err := signatureFrame("pawtalk-role-roster-alias-v1", assignment.RosterChannel, reviewed.RosterSalt)
		if err != nil {
			t.Fatal(err)
		}
		alias := sha256.Sum256(frame)
		assignment.RosterCommitment = hex.EncodeToString(alias[:])
		wrong := assignment
		wrong.RosterChannel = hiddenChannel
		commit(assignerToken, assignID, wrong, signedEdit(assigner, 2, assignID, wrong), http.StatusBadRequest)
	}
	commit(editorToken, assignID, assignment, signedEdit(editor, 3, assignID, assignment), http.StatusForbidden)
	proof := signedEdit(assigner, 2, assignID, assignment)
	changed := assignment
	changed.Remove = nil
	if body := commit(assignerToken, assignID, changed, proof, http.StatusForbidden); !bytes.Contains(body, []byte("INVALID_PROTECTED_ROLE_SIGNATURE")) {
		t.Fatalf("modified signed change returned %s", body)
	}
	accepted := commit(assignerToken, assignID, assignment, proof, http.StatusOK)
	if retry := commit(assignerToken, assignID, assignment, proof, http.StatusOK); !bytes.Equal(accepted, retry) {
		t.Fatalf("exact retry changed the receipt: %s / %s", accepted, retry)
	}
	commit(assignerToken, assignID, changed, signedEdit(assigner, 2, assignID, changed), http.StatusConflict)
	var receipt map[string]json.RawMessage
	if err := json.Unmarshal(accepted, &receipt); err != nil || len(receipt) != 5 || receipt["digest"] == nil || receipt["revision"] == nil || receipt["operationId"] == nil ||
		receipt["serverKey"] == nil || receipt["signature"] == nil {
		t.Fatalf("role receipt exposed a full proof: %s", accepted)
	}
	current, err = access.ReadPolicyHead(ctx, server.db, nil)
	if err != nil {
		t.Fatal(err)
	}
	editID := strings.Repeat("4", 32)
	edit.Revision, edit.PolicyHead = current.Draft.Revision, current.Digest
	definitions[0].Presentation = &access.RolePresentation{Name: "Роль <&>", Icon: "★", Mentionable: true}
	commit(assignerToken, editID, edit, signedEdit(assigner, 2, editID, edit), http.StatusForbidden)
	commit(editorToken, editID, edit, signedEdit(editor, 3, editID, edit), http.StatusOK)
	state, revision, err := store.Snapshot(ctx)
	if err != nil || revision != 4 || !slices.Equal(state.Members[target].Roles, []string{"other"}) ||
		state.RolePresentation["new"].Name != definitions[0].Presentation.Name || !state.CanDeliver(target, effectChannel, 0) {
		t.Fatalf("scoped commits were not applied exactly once: revision %d, %v", revision, err)
	}
	tx, err := server.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	replayErr := access.VerifyActivatedPolicyChain(ctx, tx, anchor.Digest, anchor.Principal, verifyProtectedPolicyDraft)
	if err := tx.Rollback(); replayErr != nil || err != nil {
		t.Fatalf("startup verifier rejected scoped role commits: %v / %v", replayErr, err)
	}
	t.Run("client-replay", func(t *testing.T) {
		node, err := exec.LookPath("node")
		if err != nil {
			t.Skip("Node is required for cross-language policy replay")
		}
		page, err := store.PolicyProofPage(ctx, 0)
		if err != nil {
			t.Fatal(err)
		}
		command := exec.CommandContext(ctx, node, "-e", `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createPrivateKey } = require('node:crypto');
const { ProtectedPolicyCheckpoint } = require('../client/windows/electron/protected-policy-checkpoint.cjs');
const { signScopedRoleEdit, verifyScopedRoleReceipt } = require('../client/windows/electron/protected-scoped-roles.cjs');
(async () => {
  const { page, trust, signature, receipt } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const record = JSON.parse(Buffer.from(page.proofs[2].record, 'base64'));
  const privateKey = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 102),
  ]), format: 'der', type: 'pkcs8' });
  const request = { operationId: record.Draft.OperationID, change: record.Draft.ResourceChange.RolesEdit.Change, signature };
  assert.equal(signScopedRoleEdit(trust, record.Principal, request.operationId, request.change, privateKey), signature);
  verifyScopedRoleReceipt(trust, record.Principal, request, receipt);
  assert.throws(() => verifyScopedRoleReceipt(trust, record.Principal, request, { ...receipt, digest: '0'.repeat(64) }),
    { code: 'INVALID_PROTECTED_ROLE_SIGNATURE' });
  const checkpoint = new ProtectedPolicyCheckpoint({ load: async () => undefined, save: async () => {} });
  assert.deepEqual(await checkpoint.accept(page, trust), { revision: 4, digest: page.headDigest, complete: true });
})().catch(error => { console.error(error); process.exitCode = 1; });`)
		hideWindow(command)
		command.Stdin = bytes.NewReader(encode(map[string]any{"page": page, "signature": proof, "receipt": receipt,
			"trust": map[string]any{"serverId": runtime.serverID, "anchorDigest": anchor.Digest, "cutoverDigest": runtime.cutoverDigest,
				"ownerProfileId": anchor.Principal.ProfileID, "ownerDeviceId": anchor.Principal.DeviceID}}))
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("Windows client policy replay: %v\n%s", err, output)
		}
	})
}
