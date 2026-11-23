package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProtectedMigrationInspectsConfirmedOwnerOrder(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "membership-v2.sqlite")
	now := time.Unix(10000, 0)
	store, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	inspect := func() protectedMigrationReport {
		t.Helper()
		before, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		report, err := inspectProtectedMigration(ctx, path, now)
		if err != nil {
			t.Fatal(err)
		}
		after, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(before, after) {
			t.Fatalf("inspection modified the source database: %v", err)
		}
		return report
	}
	insertTestIdentity(t, store, 8)
	if report := inspect(); report.OwnerBlocker != "JOIN_EVIDENCE_MISSING_OR_INCONSISTENT" || report.OwnerProfileID != "" {
		t.Fatalf("an unfinished identity became owner: %+v", report)
	}
	first := bootstrapTestServer(t, store, newTestMemberSigner(1))
	join := func(seed byte, role string) (memberSession, string, int64) {
		t.Helper()
		now = now.Add(time.Second)
		invite, token := createTestInvite(t, store, first.Token, "single", int(seed))
		signer := newTestMemberSigner(seed)
		request := fmt.Sprintf("%032x", seed)
		prepared, err := prepareTestInvite(t, store, signer, invite.InviteID, token, request)
		if err != nil {
			t.Fatal(err)
		}
		member, err := confirmTestInvite(t, store, signer, prepared, request, strings.Repeat("a", 64))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec("UPDATE profile_roles SET role_id=? WHERE profile_id=?", role, member.Access.ProfileID); err != nil {
			t.Fatal(err)
		}
		return member, prepared.AttemptID, now.UnixMilli()
	}
	join(2, "moderator")
	earlier, _, earlierAt := join(3, "admin")
	later, laterAttempt, _ := join(4, "admin")
	if report := inspect(); report.OwnerProfileID != first.Access.ProfileID || report.OwnerEvidence != "initial_confirmation" ||
		report.Inventory["memberships"] != 4 || report.Inventory["channels"] != 2 {
		t.Fatalf("inspection did not identify the initial successful admission: %+v", report)
	}
	if _, err := store.db.Exec("UPDATE memberships SET state='left' WHERE profile_id=?", first.Access.ProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("UPDATE memberships SET joined_at=? WHERE profile_id=?", now.Add(time.Hour).UnixMilli(), earlier.Access.ProfileID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("UPDATE sessions SET revoked_at=?", now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("UPDATE roles SET name='Administrator' WHERE role_id='moderator'"); err != nil {
		t.Fatal(err)
	}
	if report := inspect(); report.OwnerProfileID != earlier.Access.ProfileID || report.OwnerEvidence != "administrator_confirmation" {
		t.Fatalf("fallback used display name, latest membership timestamp or online status: %+v (later %s)", report, later.Access.ProfileID)
	}
	if _, err := store.db.Exec("UPDATE invite_attempts SET completed_at=? WHERE attempt_id=?", earlierAt, laterAttempt); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("UPDATE invite_redemptions SET redeemed_at=? WHERE attempt_id=?", earlierAt, laterAttempt); err != nil {
		t.Fatal(err)
	}
	if report := inspect(); report.OwnerProfileID != "" || report.OwnerBlocker != "ADMIN_JOIN_ORDER_AMBIGUOUS" {
		t.Fatalf("inspection guessed an order for equal confirmations: %+v", report)
	}
	activateTestMember(t, store, newTestMemberSigner(5), "admin")
	if report := inspect(); report.OwnerProfileID != "" || report.OwnerBlocker != "ADMIN_JOIN_EVIDENCE_MISSING" {
		t.Fatalf("inspection ignored a candidate without confirmation evidence: %+v", report)
	}
}

func TestProtectedMigrationDoesNotInitializeOrAcceptProtectedSource(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "membership-v2.sqlite")
	if _, err := inspectProtectedMigration(ctx, path, time.Now()); err == nil {
		t.Fatal("missing source passed inspection")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("inspection created a missing source: %v", err)
	}
	store, err := openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	protectedTestState(t, store)
	if _, err := inspectProtectedMigration(ctx, path, time.Now()); err == nil {
		t.Fatal("protected database passed an API 2 source inspection")
	}
}
