package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAuditProjectsScopeDeviceHandoverWithoutConsentMaterial(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "audit-handover.sqlite")))
	now := time.Unix(1_800_000_000, 0)
	store := NewStoreWithClock(db, func() time.Time { return now })
	binding, origin, successor := scopeHandoverFixture()
	originActor := Principal{ProfileID: binding.OwnerProfileID, DeviceID: binding.OwnerDeviceID}
	successorActor := Principal{ProfileID: binding.OwnerProfileID, DeviceID: hexHash(successor.Public().(ed25519.PublicKey))}
	auditor := scopeAuthorityTestKey(93)
	auditActor := Principal{ProfileID: "reader", DeviceID: hexHash(auditor.Public().(ed25519.PublicKey))}
	initial := testPolicyState()
	delete(initial.Members, initial.Owner)
	initial.Owner = binding.OwnerProfileID
	initial.Members[initial.Owner] = Subject{ID: initial.Owner, Active: true}
	initial.Roles["reader"] = Role{Grants: []string{"audit.view"}}
	initial.PolicyDevices = map[string]PolicyDevice{
		originActor.DeviceID:    {ProfileID: originActor.ProfileID, PublicKey: scopeAuthorityTestPublicKey(origin)},
		successorActor.DeviceID: {ProfileID: successorActor.ProfileID, PublicKey: scopeAuthorityTestPublicKey(successor)},
		auditActor.DeviceID:     {ProfileID: auditActor.ProfileID, PublicKey: scopeAuthorityTestPublicKey(auditor)},
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	proofSigner := scopeAuthorityTestKey(94)
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		draft.Signature = nil
		raw, err := json.Marshal(draft)
		if err != nil {
			return nil, err
		}
		return ed25519.Sign(proofSigner, raw), nil
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		expected, err := sign(ctx, query, actor, draft)
		if err != nil {
			return err
		}
		if !bytes.Equal(expected, draft.Signature) {
			return ErrPolicySignatureRequired
		}
		if draft.Action == MoveScopeDevice {
			return VerifyScopeDeviceHandover(ctx, query.(*sql.Tx), binding.ServerID, binding.CutoverDigest, actor, draft)
		}
		return nil
	}
	draft, err := store.PreviewPolicy(ctx, resolve(originActor), PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("a", 32)})
	if err != nil {
		t.Fatal(err)
	}
	draft.Signature, err = sign(ctx, db, originActor, draft)
	if err != nil {
		t.Fatal(err)
	}
	anchor, err := store.CommitPolicy(ctx, resolve(originActor), verify, draft)
	if err != nil {
		t.Fatal(err)
	}
	binding.AnchorDigest = anchor.Digest
	link := scopeHandoverLink(anchor.Digest, 2, 1, origin, successor)
	link.PolicyHead, link.ExpiresAt = anchor.Digest, now.Add(time.Minute).UnixMilli()
	link = signScopeHandoverTestLink(t, binding, link, origin, successor)
	serverKey := base64.RawURLEncoding.EncodeToString(proofSigner.Public().(ed25519.PublicKey))
	var committed PolicyProof
	for range 2 {
		proof, err := store.CommitScopeDeviceHandover(ctx, resolve(successorActor), link, binding.CutoverDigest, serverKey, sign, verify)
		if err != nil {
			t.Fatal(err)
		}
		committed = proof
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := recordAudit(ctx, tx, AuditEvent{At: now.Add(-time.Second).UnixMilli(), Actor: initial.Owner,
		Action: MoveScopeDevice, Kind: "channel", ObjectID: initial.Owner, ChannelID: initial.Owner}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := EnsureAuditSchema(ctx, tx); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var change, reason string
	if err := db.QueryRowContext(ctx, `SELECT CAST(change AS TEXT),reason FROM protected_audit_events
		WHERE action=? AND object_id=?`, MoveScopeDevice, successorActor.DeviceID).Scan(&change, &reason); err != nil ||
		change != "{}" || reason != "" {
		t.Fatalf("unexpected stored audit details: %q, %q, %v", change, reason, err)
	}
	if err := store.DispatchAudit(ctx, resolve(auditActor), "", false, func(page AuditPage) error {
		if page.CanChange || len(page.Entries) != 2 {
			t.Fatalf("unexpected delegated audit entries: %+v", page.Entries)
		}
		current, legacy := page.Entries[0], page.Entries[1]
		if current.Action != MoveScopeDevice || current.Actor != initial.Owner || current.At != now.UnixMilli() ||
			current.Kind != "device" || current.ObjectID != successorActor.DeviceID || current.ChannelID != "" ||
			legacy.Action != MoveScopeDevice || legacy.Kind != "member" || legacy.ObjectID != initial.Owner || legacy.ChannelID != "" {
			t.Fatalf("handover was projected as the wrong audit object: %+v", page.Entries)
		}
		wire, err := json.Marshal(page)
		if err != nil {
			return err
		}
		for _, value := range []string{link.DeviceKey, link.SourceDeviceID, link.Authorization, link.DeviceProof, serverKey, binding.CutoverDigest} {
			if bytes.Contains(wire, []byte(value)) {
				t.Fatal("private handover material appeared in delegated audit output")
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if head, err := ReadPolicyHead(ctx, db, nil); err != nil || head.Digest != committed.Digest {
		t.Fatalf("audit upgrade changed signed proof: %+v, %v", head, err)
	}
}
