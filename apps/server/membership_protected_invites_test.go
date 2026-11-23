package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedInviteManagement(t *testing.T) {
	ctx := context.Background()
	server := testMembershipStore(t)
	store, state, owner, guest := protectedTestStateWith(t, server, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{"invite.create"}}
	})
	commit := func(draft access.PolicyDraft) string {
		t.Helper()
		preview, err := server.previewProtectedPolicy(ctx, owner.Token, draft)
		if err != nil {
			t.Fatal(err)
		}
		proof, err := server.commitProtectedPolicy(ctx, owner.Token, signTestPolicyDraft(t, server, owner, 1, preview))
		if err != nil {
			t.Fatal(err)
		}
		return proof.Digest
	}
	head := commit(access.PolicyDraft{Action: access.AnchorPolicy, OperationID: strings.Repeat("a", 32)})
	var serverID string
	if err := server.db.QueryRow(`SELECT server_id FROM server_state WHERE id=1`).Scan(&serverID); err != nil {
		t.Fatal(err)
	}
	signInvite := func(session memberSession, seed byte, input access.InviteCreate) access.InviteCreate {
		t.Helper()
		input.PolicyDigest = head
		uses := int64(1)
		if input.MaxUses != nil {
			uses = *input.MaxUses
		}
		frame, err := protectedInvitationFrame(serverID, access.Principal{ProfileID: session.Access.EffectiveProfileID,
			DeviceID: session.Access.DeviceID}, input, uses)
		if err != nil {
			t.Fatal(err)
		}
		input.Signature = ed25519.Sign(newTestMemberSigner(seed).device, frame)
		return input
	}
	create := func(session memberSession, invite access.InviteCreate) (access.InviteReceipt, error) {
		return store.CreateInvite(ctx, server.protectedSession(session.Token), verifyProtectedInvitation, invite)
	}
	list := func(session memberSession, before string) (access.InvitePage, error) {
		var captured access.InvitePage
		err := store.DispatchInvites(ctx, server.protectedSession(session.Token), before, func(page access.InvitePage) error {
			captured = page
			return nil
		})
		return captured, err
	}
	revoke := func(session memberSession, id string) error {
		return store.RevokeInvite(ctx, server.protectedSession(session.Token), id)
	}
	defaultInvite := signInvite(guest, 2, access.InviteCreate{ID: strings.Repeat("1", 32), TokenHash: strings.Repeat("1", 64)})
	type outcome struct {
		receipt access.InviteReceipt
		err     error
	}
	ready := make(chan outcome, 2)
	for range 2 {
		go func() {
			receipt, err := create(guest, defaultInvite)
			ready <- outcome{receipt, err}
		}()
	}
	first, second := <-ready, <-ready
	if first.err != nil || second.err != nil || first.receipt.Existing == second.receipt.Existing || first.receipt.Invite != second.receipt.Invite {
		t.Fatalf("concurrent create: %+v %+v", first, second)
	}
	if info := first.receipt.Invite; info.MaxUses != 1 || info.Uses != 0 || info.ExpiresAt-info.CreatedAt != 86_400_000 {
		t.Fatalf("default invitation settings: %+v", info)
	}
	unlimited := int64(0)
	ownerInvite := signInvite(owner, 1, access.InviteCreate{ID: strings.Repeat("2", 32), TokenHash: strings.Repeat("2", 64),
		ExpiresAt: server.now().UnixMilli() + 3600_000, MaxUses: &unlimited})
	if receipt, err := create(owner, ownerInvite); err != nil || receipt.Invite.MaxUses != 0 || receipt.Invite.ExpiresAt != ownerInvite.ExpiresAt {
		t.Fatalf("manual deadline and unlimited uses: %+v %v", receipt, err)
	}
	tampered := signInvite(guest, 2, access.InviteCreate{ID: strings.Repeat("3", 32), TokenHash: strings.Repeat("3", 64)})
	tampered.TokenHash = strings.Repeat("4", 64)
	var invalidSignature *membershipError
	if _, err := create(guest, tampered); !errors.As(err, &invalidSignature) || invalidSignature.Code != "INVALID_PROTECTED_INVITE_SIGNATURE" {
		t.Fatalf("substituted hash accepted: %v", err)
	}
	expired := signInvite(guest, 2, access.InviteCreate{ID: strings.Repeat("9", 32), TokenHash: strings.Repeat("9", 64), ExpiresAt: 1})
	if _, err := create(guest, expired); !errors.Is(err, access.InvalidAction) {
		t.Fatalf("issued an expired invite: %v", err)
	}
	own, err := list(guest, "")
	if err != nil || !own.CanCreate || len(own.Invites) != 1 || own.Invites[0].ID != defaultInvite.ID || !own.Invites[0].CanRevoke {
		t.Fatalf("own list: %+v %v", own, err)
	}
	if _, err := list(guest, ownerInvite.ID); !errors.Is(err, access.ErrInviteCursor) {
		t.Fatalf("foreign cursor disclosed existence: %v", err)
	}
	stale := signInvite(guest, 2, access.InviteCreate{ID: strings.Repeat("5", 32), TokenHash: strings.Repeat("5", 64)})
	setGrants := func(operation string, grants ...string) {
		state.Roles["reader"] = access.Role{Grants: grants}
		head = commit(access.PolicyDraft{Action: access.UpdatePolicyRoles, OperationID: strings.Repeat(operation, 32),
			RoleUpdate: &access.RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	}
	setGrants("b", "invite.create", "invite.view-all")
	if _, err := create(guest, stale); !errors.Is(err, access.ErrPolicyConflict) {
		t.Fatalf("accepted previously signed invitation after policy changed: %v", err)
	}
	page, err := list(guest, "")
	if err != nil || len(page.Invites) != 2 || page.Invites[0].ID != ownerInvite.ID || page.Invites[0].CanRevoke {
		t.Fatalf("view-all list: %+v %v", page, err)
	}
	body, err := json.Marshal(page)
	if err != nil || strings.Contains(string(body), ownerInvite.TokenHash) || strings.Contains(string(body), "signature") || strings.Contains(string(body), "policyDigest") {
		t.Fatalf("list leaked credential or proof: %s %v", body, err)
	}
	if err := revoke(guest, ownerInvite.ID); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("view-all was treated as manage-all: %v", err)
	}
	setGrants("c", "invite.create", "invite.manage-all")
	if page, err := list(guest, ""); err != nil || len(page.Invites) != 1 || page.Invites[0].ID != defaultInvite.ID {
		t.Fatalf("manage-all revealed foreign metadata without view-all: %+v %v", page, err)
	}
	for range 2 {
		if err := revoke(guest, ownerInvite.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := revoke(guest, defaultInvite.ID); err != nil {
		t.Fatal(err)
	}
	if result, err := create(guest, defaultInvite); err != nil || !result.Existing || result.Invite.RevokedAt == 0 || result.Invite.CanRevoke {
		t.Fatalf("retry recreated a revoked invitation: %+v %v", result, err)
	}
	var events int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM protected_audit_events WHERE kind='invite'`).Scan(&events); err != nil || events != 4 {
		t.Fatalf("invite audit was not idempotent: %d %v", events, err)
	}
	canList := func() bool {
		t.Helper()
		var permission bool
		if err := store.DispatchVisibleState(ctx, server.protectedSession(guest.Token), func(view access.Projection) error {
			permission = view.CanListInvites
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return permission
	}
	setGrants("e", "invite.view-all")
	if page, err := list(guest, ""); err != nil || !canList() || page.CanCreate || page.PolicyHead != "" || len(page.Invites) != 2 {
		t.Fatalf("view-only invitation access: %+v %v", page, err)
	}
	setGrants("d")
	if canList() {
		t.Fatal("visible state retained revoked invitation access")
	}
	if _, err := create(guest, defaultInvite); !errors.Is(err, access.MissingGrant) {
		t.Fatalf("retry delivered a receipt after loss of invite rights: %v", err)
	}
}
