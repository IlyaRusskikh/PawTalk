package access

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAuditScopesRetentionAndIndependentPolicyProofs(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "audit.sqlite")))
	now := time.Unix(1_800_000_000, 0)
	store := NewStoreWithClock(db, func() time.Time { return now })
	state := testPolicyState()
	state.Roles["reader"] = Role{Grants: []string{"audit.view", "message.send"}}
	state.Roles["directory"] = Role{Grants: []string{"member.list"}}
	state.Order = append(state.Order, "directory")
	state.Members["list-only"] = Subject{ID: "list-only", Active: true, Roles: []string{"directory"}}
	state.Categories["private"] = ACL{Roles: map[string]Overwrite{Everyone: {Deny: []string{ChannelView}}}}
	state.PolicyDevices = make(map[string]PolicyDevice)
	state.KeyRecipients = make(map[string]KeyRecipient)
	actors := make(map[string]Principal)
	for profile, seed := range map[string]byte{"owner": 21, "reader": 23, "list-only": 25} {
		keyBytes := make([]byte, 32)
		keyBytes[0] = seed
		key := hex.EncodeToString(keyBytes)
		sum := sha256.Sum256(keyBytes)
		id := hex.EncodeToString(sum[:])
		state.PolicyDevices[id] = PolicyDevice{ProfileID: profile, PublicKey: key}
		state.KeyRecipients[id] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: key}
		actors[profile] = Principal{ProfileID: profile, DeviceID: id}
	}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	resolve := func(profile string) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actors[profile], nil }
	}
	commit := func(input PolicyDraft) PolicyProof {
		t.Helper()
		draft, err := store.PreviewPolicy(ctx, resolve("owner"), input)
		if err != nil {
			t.Fatal(err)
		}
		draft.Signature = make([]byte, 64)
		draft.Signature[0] = byte(draft.Revision)
		proof, err := store.CommitPolicy(ctx, resolve("owner"), func(context.Context, SessionQuery, Principal, PolicyDraft) error {
			return nil
		}, draft)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	commit(PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("a", 32)})
	state.Roles["reader"] = Role{Grants: []string{"audit.view", "message.send", "message.delete-other"}}
	proof := commit(PolicyDraft{Action: UpdatePolicyRoles, OperationID: strings.Repeat("b", 32),
		RoleUpdate: &RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	synthetic := []byte("synthetic plaintext marker")
	message, err := store.AppendMessage(ctx, resolve("reader"),
		func(context.Context, SessionQuery, Principal, int64, MessageAttempt) error { return nil },
		MessageAttempt{ChannelID: "public", OperationID: strings.Repeat("c", 32), KeyID: strings.Repeat("d", 64),
			Nonce: make([]byte, 12), Ciphertext: synthetic, Signature: make([]byte, 64)}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteMessage(ctx, resolve("reader"), nil, "public", message.Position); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	insert := func(entry AuditEvent) {
		t.Helper()
		if err := recordAudit(ctx, tx, entry); err != nil {
			t.Fatal(err)
		}
	}
	for range 32 {
		insert(AuditEvent{At: now.UnixMilli(), Actor: "owner", Action: OrderPolicyChannel, Kind: "channel",
			ChannelID: "public", ObjectID: "public"})
		insert(AuditEvent{At: now.UnixMilli(), Actor: "owner", Action: OrderPolicyChannel, Kind: "channel",
			ChannelID: "secret", ObjectID: "secret"})
	}
	insert(AuditEvent{At: now.UnixMilli(), Actor: "owner", Action: UpdateCategoryACL, Kind: "category",
		category: "private", ObjectID: "private"})
	insert(AuditEvent{At: now.UnixMilli(), Actor: "owner", Action: "message.delete", Kind: "message",
		ChannelID: "public", Position: 49, ObjectID: "49"})
	insert(AuditEvent{At: now.AddDate(0, 0, -10).UnixMilli(), Actor: "owner", Action: "member.timeout", Kind: "member",
		ObjectID: "reader", Reason: "Older reason"})
	insert(AuditEvent{At: now.AddDate(0, 0, -366).UnixMilli(), Actor: "owner", Action: "member.timeout", Kind: "member",
		ObjectID: "reader", Reason: "Already expired"})
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var page AuditPage
	read := func(profile, before string) error {
		return store.DispatchAudit(ctx, resolve(profile), before, false, func(result AuditPage) error { page = result; return nil })
	}
	if err := read("list-only", ""); !errors.Is(err, MissingGrant) {
		t.Fatalf("member.list exposed the audit log: %v", err)
	}
	if err := read("reader", ""); err != nil || len(page.Entries) != 32 || page.Next == "" || page.CanChange || page.Retention != 365 {
		t.Fatalf("visible audit first page: %+v, %v", page, err)
	}
	for _, entry := range page.Entries {
		if entry.ChannelID != "public" || entry.Position != 0 {
			t.Fatalf("hidden scope influenced the page: %+v", entry)
		}
	}
	readerCursor := page.Next
	var hiddenCursor string
	if err := db.QueryRowContext(ctx, "SELECT cursor FROM protected_audit_events WHERE channel_id='secret' ORDER BY sequence DESC LIMIT 1").
		Scan(&hiddenCursor); err != nil {
		t.Fatal(err)
	}
	if err := read("reader", hiddenCursor); !errors.Is(err, ErrAuditCursor) {
		t.Fatalf("out-of-scope audit cursor resolved: %v", err)
	}
	if err := read("owner", hiddenCursor); err != nil {
		t.Fatalf("owner could not resolve an in-scope audit cursor: %v", err)
	}
	if err := read("reader", readerCursor); err != nil || len(page.Entries) != 3 || page.Next != "" {
		t.Fatalf("visible audit last page: %+v, %v", page, err)
	}
	if page.Entries[0].Position != message.Position || page.Entries[1].Action != "role.update" ||
		len(page.Entries[1].Change.Added) != 1 || page.Entries[1].Change.Added[0] != "message.delete-other" ||
		page.Entries[2].Reason != "Older reason" {
		t.Fatalf("incorrect typed changes: %+v", page.Entries)
	}
	if err := store.ChangeAuditRetention(ctx, resolve("owner"), AuditRetentionRequest{Days: 500, Expected: 365}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE reason='Already expired'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("extension revived expired audit records: %d, %v", count, err)
	}
	shorten := AuditRetentionRequest{Days: 7, Expected: 500}
	if err := store.ChangeAuditRetention(ctx, resolve("reader"), shorten); !errors.Is(err, MissingGrant) {
		t.Fatalf("non-Administrator changed retention: %v", err)
	}
	if err := store.ChangeAuditRetention(ctx, resolve("owner"), shorten); !errors.Is(err, ErrAuditRetentionConfirmation) {
		t.Fatalf("shortened without confirmation: %v", err)
	}
	shorten.ConfirmShorter = true
	if err := store.ChangeAuditRetention(ctx, resolve("owner"), shorten); err != nil {
		t.Fatal(err)
	}
	if err := read("owner", ""); err != nil || !page.CanChange || page.Retention != 7 || page.Entries[0].Action != "audit.retention" {
		t.Fatalf("audit settings or their event missing: %+v, %v", page, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE reason='Older reason'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("old audit records were not purged: %d, %v", count, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE instr(CAST(change AS TEXT),?)>0 OR instr(reason,?)>0",
		string(synthetic), string(synthetic)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("message plaintext entered the audit: %d, %v", count, err)
	}
	if head, err := ReadPolicyHead(ctx, db, nil); err != nil || head.Digest != proof.Digest {
		t.Fatalf("pruning changed policy proofs: %+v, %v", head, err)
	}
}

func TestAuditUpgradeMovesLegacyTimeoutReasonOnce(t *testing.T) {
	ctx := context.Background()
	db, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "audit-upgrade.sqlite")))
	if err := store.Initialize(ctx, testPolicyState()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO protected_timeout_actions
		(device_id,operation_id,actor_profile_id,target_profile_id,duration_seconds,reason,previous_deadline,deadline,applied_at)
		VALUES('device','request','owner','reader',60,'Legacy reason',0,61000,1000)`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := EnsureAuditSchema(ctx, tx); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	var entries int
	if err := db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE reason='Legacy reason' AND occurred_at=1000").
		Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("upgrade audit rows = %d, %v", entries, err)
	}
	var fingerprint string
	if err := db.QueryRow("SELECT reason FROM protected_timeout_actions WHERE operation_id='request'").Scan(&fingerprint); err != nil ||
		fingerprint != timeoutReasonFingerprint("Legacy reason") {
		t.Fatalf("legacy receipt did not retain the request fingerprint: %v", err)
	}
}
