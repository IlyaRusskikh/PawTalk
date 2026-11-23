package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedMigrationPolicyPreservesEffectiveLegacyGrants(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(10000, 0)
	path := filepath.Join(t.TempDir(), membershipDatabaseFile)
	store, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	owner := bootstrapTestServer(t, store, newTestMemberSigner(1))
	moderator := activateTestMember(t, store, newTestMemberSigner(2), "moderator")
	admin := activateTestMember(t, store, newTestMemberSigner(3), "admin")
	overridden := activateTestMember(t, store, newTestMemberSigner(4), "admin")
	linked := activateTestMember(t, store, newTestMemberSigner(5), "admin")
	left := activateTestMember(t, store, newTestMemberSigner(6), "admin")
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{"UPDATE roles SET name='Administrator' WHERE role_id='moderator'", nil},
		{"INSERT INTO group_roles(profile_id,role_id) VALUES(?,'member')", []any{overridden.ProfileID}},
		{"UPDATE memberships SET state='linked' WHERE profile_id=?", []any{linked.ProfileID}},
		{"INSERT INTO profile_bindings(source_profile_id,target_profile_id,created_at) VALUES(?,?,?)", []any{linked.ProfileID, overridden.ProfileID, now.UnixMilli()}},
		{"UPDATE memberships SET state='left' WHERE profile_id=?", []any{left.ProfileID}},
	} {
		if _, err := store.db.Exec(statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	report, err := copyMigrationDatabase(t, path).prepare(ctx, path, now)
	if err != nil {
		t.Fatal(err)
	}
	draft := loadTestMigrationPolicyDraft(t, store)
	if len(draft.Blockers) != 0 || !draft.OwnerRecoveryRequired || draft.State == nil || draft.State.Owner != owner.Access.ProfileID || draft.State.Owner != report.OwnerProfileID ||
		!slices.Equal(draft.AdministratorPending, []string{admin.ProfileID}) || draft.State.PolicyAnchored || len(draft.State.KeyRecipients) != 0 {
		t.Fatalf("invalid migration draft: %+v", draft)
	}
	if draft.RoleMetadata["moderator"].Name != "Administrator" || !slices.Equal(draft.State.Order, []string{"member", "moderator", "admin"}) {
		t.Fatal("legacy labels or ranks changed")
	}
	assertPermission := func(profile, scope, grant string, expected access.Decision) {
		t.Helper()
		if decision := draft.State.CheckGrant(draft.State.Members[profile], access.Scope{Kind: scope}, grant, now.UnixMilli()); decision != expected {
			t.Fatalf("%s: %s, expected %s", grant, decision, expected)
		}
	}
	assertPermission(moderator.ProfileID, "", "invite.create", access.Allowed)
	assertPermission(moderator.ProfileID, "", "member.kick", access.MissingGrant)
	assertPermission(moderator.ProfileID, "", "member.ban", access.MissingGrant)
	assertPermission(moderator.ProfileID, "text", "history.full", access.Allowed)
	assertPermission(admin.ProfileID, "", "role.assign", access.Allowed)
	assertPermission(admin.ProfileID, "", access.Administrator, access.MissingGrant)
	assertPermission(overridden.ProfileID, "", "invite.create", access.MissingGrant)
	if draft.State.Members[left.ProfileID].Active || len(draft.State.Members[left.ProfileID].Roles) != 0 ||
		draft.State.Members[linked.ProfileID].ID != linked.ProfileID || draft.State.Members[linked.ProfileID].Active ||
		len(draft.State.Members[linked.ProfileID].Roles) != 0 || draft.State.PolicyDevices[linked.DeviceID].ProfileID != overridden.ProfileID ||
		!draft.State.ImportedProfileBindings || draft.State.ProfileBindings[linked.ProfileID] != overridden.ProfileID ||
		draft.State.ProfileDeviceOrigins[linked.DeviceID] != linked.ProfileID || len(draft.State.ProfileDeviceOrigins) != 1 ||
		draft.State.PolicyDevices[left.DeviceID].ProfileID != "" {
		t.Fatal("migration did not preserve signed origin metadata, or restored stale roles")
	}
	isolated := testMembershipStore(t)
	if err := access.NewStore(isolated.db).Initialize(ctx, *draft.State); err != nil {
		t.Fatalf("draft is incompatible with the protected policy store: %v", err)
	}
	format := migrationPolicyFormat{seed: strings.Repeat("a", 64), projectionVersion: access.VoiceRecipientProjectionVersion}
	recipient := migrationRecipientReceipt{ReviewDigest: strings.Repeat("b", 64), DeviceID: owner.Access.DeviceID,
		PublicKey: testRecipientKey(t, 21)}
	current, err := previewMigrationInitialPolicy(draft, report.OwnerProfileID, recipient, format)
	if err != nil {
		t.Fatalf("versioned migration initial policy: %v", err)
	}
	var signed access.State
	if err := json.Unmarshal(current.Snapshot, &signed); err != nil || !signed.ImportedProfileBindings ||
		signed.ProfileBindings[linked.ProfileID] != overridden.ProfileID || signed.ProfileDeviceOrigins[linked.DeviceID] != linked.ProfileID {
		t.Fatalf("profile origins missing from initial signed snapshot: %v", err)
	}

	// A checkpoint created before this format has the original frozen table
	// and review bytes even if an import approval already refers to them.
	frozen := *draft.State
	frozen.ImportedProfileBindings, frozen.ProfileBindings, frozen.ProfileDeviceOrigins = false, nil, nil
	frozen.Members = maps.Clone(frozen.Members)
	delete(frozen.Members, linked.ProfileID)
	legacyExpected := draft
	legacyExpected.State = &frozen
	legacyRaw, err := json.Marshal(legacyExpected)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`ALTER TABLE protected_migration_source DROP COLUMN imported_profile_bindings`); err != nil {
		t.Fatal(err)
	}
	legacy := loadTestMigrationPolicyDraft(t, store)
	raw, err := json.Marshal(legacy)
	if err != nil || !bytes.Equal(raw, legacyRaw) {
		t.Fatalf("previous freeze format changed its serialized policy review: %v", err)
	}
	legacyPreview, err := previewMigrationInitialPolicy(legacy, report.OwnerProfileID, recipient, format)
	if err != nil {
		t.Fatal(err)
	}
	legacySeed, err := previewMigrationInitialPolicy(legacyExpected, report.OwnerProfileID, recipient, format)
	if err != nil || legacyPreview.Draft.ResultDigest != legacySeed.Draft.ResultDigest || !bytes.Equal(legacyPreview.Snapshot, legacySeed.Snapshot) ||
		legacyPreview.Draft.ResultDigest == current.Draft.ResultDigest || legacyPreview.Draft.TextProjectionRoot != current.Draft.TextProjectionRoot {
		t.Fatalf("legacy genesis changed or structural import affected channel privileges: %v", err)
	}
}

func TestProtectedMigrationPolicyReportsSplitInvitesAndUnrepresentableVisibility(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(10000, 0)
	path := filepath.Join(t.TempDir(), membershipDatabaseFile)
	store, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	bootstrapTestServer(t, store, newTestMemberSigner(1))
	moderator := activateTestMember(t, store, newTestMemberSigner(2), "moderator")
	if _, err := store.db.Exec(`DELETE FROM role_permissions WHERE role_id='moderator' AND permission IN ('invite.revoke.own','chat.read');
		INSERT INTO role_permissions VALUES('moderator','unknown.grant'); INSERT INTO roles VALUES('extra','Extra',NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err := copyMigrationDatabase(t, path).prepare(ctx, path, now); err != nil {
		t.Fatal(err)
	}
	draft := loadTestMigrationPolicyDraft(t, store)
	if draft.State != nil {
		t.Fatal("migration offered a policy with unresolved privilege changes")
	}
	for _, expected := range []migrationPolicyBlocker{
		{Code: "LEGACY_INVITE_GRANTS_SPLIT", RoleID: "moderator"},
		{Code: "UNMAPPED_LEGACY_PERMISSION", RoleID: "moderator", Detail: "unknown.grant"},
		{Code: "LEGACY_TEXT_METADATA_WITHOUT_READ", ProfileID: moderator.ProfileID},
		{Code: "LEGACY_ROLE_RANK_TIE", RoleID: "member", Detail: "extra"},
	} {
		if !slices.Contains(draft.Blockers, expected) {
			t.Fatalf("migration dropped a compatibility blocker: %+v, got %+v", expected, draft.Blockers)
		}
	}
}

func TestProtectedMigrationPositionsKeepExactSourceIDsAndChannelOrder(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(10000, 0)
	path := filepath.Join(t.TempDir(), membershipDatabaseFile)
	store, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	owner := bootstrapTestServer(t, store, newTestMemberSigner(1))
	insertMigrationCiphertextFixture(t, store, owner.Access, false)
	const other = "ffffffffffffffffffffffffffffffff"
	const largeID int64 = 9223372036854775807
	if _, err := store.db.Exec("INSERT INTO channels(channel_id,kind,name,position) VALUES(?,'text','Other',1)", other); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO messages(message_id,channel_id,author_profile_id,author_device_id,request_id,sent_at,crypto_context_id,nonce,ciphertext)
		SELECT ?,?,author_profile_id,author_device_id,'other-channel-request',sent_at,crypto_context_id,nonce,ciphertext
		FROM messages WHERE message_id=9007199254740991`, largeID, other); err != nil {
		t.Fatal(err)
	}
	if _, err := copyMigrationDatabase(t, path).prepare(ctx, path, now); err != nil {
		t.Fatal(err)
	}
	var firstChannel string
	if err := store.db.QueryRow("SELECT channel_id FROM channels WHERE protected_kind='default_text'").Scan(&firstChannel); err != nil {
		t.Fatal(err)
	}
	rows, err := store.db.QueryContext(ctx, migrationMessagePositionsQuery+" ORDER BY message_id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type item struct {
		channel      string
		id, position int64
	}
	var actual []item
	for rows.Next() {
		var row item
		if err := rows.Scan(&row.channel, &row.id, &row.position); err != nil {
			t.Fatal(err)
		}
		actual = append(actual, row)
	}
	expected := []item{{firstChannel, 9007199254740991, 1}, {firstChannel, 9007199254740994, 2}, {other, largeID, 1}}
	if err := rows.Err(); err != nil || !slices.Equal(actual, expected) {
		t.Fatalf("unexpected positions: %+v, %v", actual, err)
	}
	draft := loadTestMigrationPolicyDraft(t, store)
	if draft.State == nil || draft.State.Channels[firstChannel].NextPosition != 3 || draft.State.Channels[other].NextPosition != 2 {
		t.Fatalf("policy cursors diverged from channel positions: %+v", draft)
	}
}

func loadTestMigrationPolicyDraft(t *testing.T, store *membershipStore) migrationPolicyDraft {
	t.Helper()
	ctx := context.Background()
	tx, err := store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := readMigrationPolicyDraft(ctx, tx, authority)
	if err != nil {
		t.Fatal(err)
	}
	return draft
}
