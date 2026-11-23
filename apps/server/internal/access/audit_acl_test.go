package access

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestAuditChannelACLRecordsScopedRuleChanges(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "audit-acl.sqlite")))
	now := time.Unix(1_800_000_000, 0)
	store := NewStoreWithClock(db, func() time.Time { return now })
	owner, viewer, target := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64)
	visible, hidden, category := strings.Repeat("7", 32), strings.Repeat("8", 32), strings.Repeat("9", 32)
	serverID, cutover := strings.Repeat("a", 32), strings.Repeat("b", 64)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner, Order: []string{"auditor", "quiet"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView}}, "auditor": {Grants: []string{"audit.view"}}, "quiet": {},
			}},
			Members: map[string]Subject{
				owner: {ID: owner, Active: true}, viewer: {ID: viewer, Active: true, Roles: []string{"auditor"}},
				target: {ID: target, Active: true, Roles: []string{"quiet"}},
			},
		},
		Channels: map[string]Channel{
			visible: {Kind: "text", CategoryID: category, Synchronized: true, NextPosition: 1},
			hidden:  {Kind: "text", NextPosition: 1, ACL: ACL{Profiles: map[string]Overwrite{viewer: {Deny: []string{ChannelView}}}}},
		},
		Categories:    map[string]ACL{category: {Roles: map[string]Overwrite{"quiet": {Allow: []string{"message.send"}}}}},
		PolicyDevices: make(map[string]PolicyDevice),
		KeyRecipients: make(map[string]KeyRecipient),
	}
	ownerKey := scopeAuthorityTestKey(1)
	actors := make(map[string]Principal)
	for i, profile := range []string{owner, viewer, target} {
		seed := byte(i + 1)
		public := scopeAuthorityTestKey(seed).Public().(ed25519.PublicKey)
		device := hexHash(public)
		actors[profile] = Principal{ProfileID: profile, DeviceID: device}
		state.PolicyDevices[device] = PolicyDevice{ProfileID: profile, PublicKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(seed))}
		state.KeyRecipients[device] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: recoveryTestAgreementKey(t, seed)}
	}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	resolve := func(profile string) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actors[profile], nil }
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		switch draft.Action {
		case EditScopedChannelACLRoleRules:
			return VerifyScopedChannelACLRoleRulesEdit(ctx, query, serverID, actor, draft)
		case EditScopedChannelACLPersonal:
			return VerifyScopedChannelACLPersonalEdit(ctx, query, serverID, actor, draft)
		default:
			return nil
		}
	}
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		return ed25519.Sign(ownerKey, []byte(draft.OperationID)), nil
	}
	commit := func(draft PolicyDraft) PolicyProof {
		t.Helper()
		preview, err := store.PreviewPolicy(ctx, resolve(owner), draft)
		if err != nil {
			t.Fatal(err)
		}
		preview.Signature, _ = sign(ctx, db, actors[owner], preview)
		head, err := store.CommitPolicy(ctx, resolve(owner), verify, preview)
		if err != nil {
			t.Fatal(err)
		}
		return head
	}
	serverKey := base64.RawURLEncoding.EncodeToString(scopeAuthorityTestKey(4).Public().(ed25519.PublicKey))
	anchor := commit(PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32),
		TextProjectionVersion: ChannelACLProjectionVersion, TextProjectionSeed: strings.Repeat("aa", 32)})
	rules := map[string]Overwrite{"quiet": {Allow: []string{"history.full"}, Deny: []string{"message.pin"}}}
	oldDigest, err := channelACLRoleRulesDigest(state.Categories[category].Roles)
	if err != nil {
		t.Fatal(err)
	}
	newDigest, err := channelACLRoleRulesDigest(rules)
	if err != nil {
		t.Fatal(err)
	}
	operation := strings.Repeat("2", 32)
	frame, err := SignatureFrame("pawtalk-protected-channel-acl-roles-edit-v1", serverID, cutover, owner, actors[owner].DeviceID,
		operation, "1", anchor.Digest, visible, "text", category, oldDigest, newDigest)
	if err != nil {
		t.Fatal(err)
	}
	head, err := store.CommitScopedChannelACLRoleRulesEdit(ctx, resolve(owner), PolicyDraft{
		Action: EditScopedChannelACLRoleRules, OperationID: operation, PreviousDigest: anchor.Digest,
		ResourceChange: &PolicyResourceChange{ID: visible, ACL: &ACL{Roles: rules}, ACLRoleEdit: &PolicyChannelACLRoleEdit{
			CutoverDigest: cutover, PreviousRulesDigest: oldDigest, ServerKey: serverKey,
			EditorProof: base64.RawURLEncoding.EncodeToString(ed25519.Sign(ownerKey, frame)),
		}},
	}, sign, verify)
	if err != nil {
		t.Fatal(err)
	}
	for i, rule := range []string{"allow", "deny"} {
		operation := strings.Repeat(strconv.Itoa(i+3), 32)
		frame, err := SignatureFrame("pawtalk-protected-channel-acl-personal-edit-v1", serverID, cutover, owner, actors[owner].DeviceID,
			operation, strconv.FormatInt(head.Draft.Revision, 10), head.Digest, visible, "text", category, target, "history.full", rule)
		if err != nil {
			t.Fatal(err)
		}
		head, err = store.CommitScopedChannelACLPersonalEdit(ctx, resolve(owner), PolicyDraft{Action: EditScopedChannelACLPersonal,
			OperationID: operation, PreviousDigest: head.Digest, ResourceChange: &PolicyResourceChange{
				ID: visible, TargetProfileID: target, ACLPersonalEdit: &PolicyChannelACLPersonalEdit{
					CutoverDigest: cutover, Permission: "history.full", Rule: rule, ServerKey: serverKey,
					EditorProof: base64.RawURLEncoding.EncodeToString(ed25519.Sign(ownerKey, frame)),
				}},
		}, sign, verify)
		if err != nil {
			t.Fatal(err)
		}
	}
	commit(PolicyDraft{Action: SyncChannelACL, OperationID: strings.Repeat("5", 32), TextProjectionVersion: ChannelACLProjectionVersion,
		TextProjectionSeed: strings.Repeat("cc", 32), ResourceChange: &PolicyResourceChange{ID: visible}})
	commit(PolicyDraft{Action: UpdateChannelACL, OperationID: strings.Repeat("6", 32), TextProjectionVersion: ChannelACLProjectionVersion,
		TextProjectionSeed: strings.Repeat("dd", 32), ResourceChange: &PolicyResourceChange{ID: hidden, ACL: &ACL{
			Profiles: state.Channels[hidden].ACL.Profiles, Roles: map[string]Overwrite{"quiet": {Deny: []string{"message.send"}}},
		}}})
	read := func(profile string) AuditPage {
		t.Helper()
		var page AuditPage
		if err := store.DispatchAudit(ctx, resolve(profile), "", false, func(result AuditPage) error { page = result; return nil }); err != nil {
			t.Fatal(err)
		}
		return page
	}
	ownerPage, viewerPage := read(owner), read(viewer)
	if len(ownerPage.Entries) != 5 || ownerPage.Entries[0].ChannelID != hidden ||
		!slices.Equal(ownerPage.Entries[0].Change.Added, []string{"deny:message.send"}) {
		t.Fatalf("generic ACL audit did not record the hidden channel for the owner: %+v", ownerPage.Entries)
	}
	expected := []struct {
		action, object string
		added, removed []string
	}{
		{SyncChannelACL, visible, []string{"allow:message.send"}, []string{"allow:history.full", "deny:history.full", "deny:message.pin"}},
		{UpdateChannelACL, target, []string{"deny:history.full"}, []string{"allow:history.full"}},
		{UpdateChannelACL, target, []string{"allow:history.full"}, nil},
		{UpdateChannelACL, visible, []string{"allow:history.full", "deny:message.pin"}, []string{"allow:message.send"}},
	}
	if len(viewerPage.Entries) != len(expected) {
		t.Fatalf("hidden event leaked or visible event lost: %+v", viewerPage.Entries)
	}
	for i, entry := range viewerPage.Entries {
		want := expected[i]
		if entry.Action != want.action || entry.ObjectID != want.object || entry.ChannelID != visible ||
			!slices.Equal(entry.Change.Added, want.added) || !slices.Equal(entry.Change.Removed, want.removed) {
			t.Fatalf("event %d: got %+v, wanted %+v", i, entry, want)
		}
	}
	raw, err := json.Marshal(viewerPage)
	if err != nil || strings.Contains(string(raw), hidden) || strings.Contains(string(raw), category) ||
		strings.Contains(string(raw), "quiet") || strings.Contains(string(raw), serverKey) || strings.Contains(string(raw), actors[target].DeviceID) {
		t.Fatalf("scoped delta exposed unrelated metadata: %s %v", raw, err)
	}
}
