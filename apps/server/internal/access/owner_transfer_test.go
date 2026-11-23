package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestOwnershipTransferOfferLifecycle(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	now := time.UnixMilli(90_000)
	store := NewStoreWithClock(db, func() time.Time { return now })
	oldID, targetID, unrelatedID := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	hidden := strings.Repeat("d", 32)
	initial := State{RoleSnapshot: RoleSnapshot{
		Policy: Policy{Owner: oldID, Order: []string{"reader"}, Roles: map[string]Role{Everyone: {}, "reader": {Grants: []string{ChannelView}}}},
		Members: map[string]Subject{oldID: {ID: oldID, Active: true, Roles: []string{"reader"}}, targetID: {ID: targetID, Active: true},
			unrelatedID: {ID: unrelatedID, Active: true}},
	}, Channels: map[string]Channel{hidden: {Kind: "text", NextPosition: 4}},
		PolicyDevices: make(map[string]PolicyDevice), KeyRecipients: make(map[string]KeyRecipient),
		RecoveryReady: map[string]bool{targetID: true}}
	device := func(profile string, seed byte, recipient bool) (Principal, ed25519.PrivateKey) {
		t.Helper()
		key := scopeAuthorityTestKey(seed)
		actor := Principal{ProfileID: profile, DeviceID: hexHash(key.Public().(ed25519.PublicKey))}
		initial.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: profile, PublicKey: scopeAuthorityTestPublicKey(key)}
		if recipient {
			initial.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: recoveryTestAgreementKey(t, seed+40)}
		}
		return actor, key
	}
	owner, oldKey := device(oldID, 1, true)
	firstTarget, _ := device(targetID, 2, true)
	accepting, acceptingKey := device(targetID, 3, false)
	unrelated, _ := device(unrelatedID, 4, true)
	recovery := RecoveryIdentity{ID: strings.Repeat("e", 64), SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(5)), AgreementKey: recoveryTestAgreementKey(t, 45)}
	initial.RecoveryIdentities = map[string]RecoveryIdentity{targetID: recovery}
	initial.KeyRecipients[recovery.ID] = KeyRecipient{ProfileID: targetID, Kind: "recovery", PublicKey: recovery.AgreementKey}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	serverPrivate := scopeAuthorityTestKey(6)
	serverKey := base64.RawURLEncoding.EncodeToString(serverPrivate.Public().(ed25519.PublicKey))
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		frame, err := SignatureFrame(draft.Action, draft.OperationID, draft.ResultDigest, draft.TextProjectionRoot, draft.PreviousDigest)
		if err != nil {
			return nil, err
		}
		return ed25519.Sign(serverPrivate, frame), nil
	}
	op := func(index byte) string { return fmt.Sprintf("%032x", index) }
	binding := ScopeAuthorityContext{ServerID: strings.Repeat("1", 32), CutoverDigest: strings.Repeat("f", 64), OwnerProfileID: oldID, OwnerDeviceID: owner.DeviceID}
	linkFor := func(offer OwnerTransferOffer) ScopeAuthorityLink {
		return ScopeAuthorityLink{Action: TransferPolicyOwnership, Sequence: offer.Sequence, Previous: offer.Previous,
			OperationID: offer.OperationID, Revision: offer.HeadRevision + 1, PolicyHead: offer.PolicyHead,
			TargetProfileID: offer.TargetProfileID, RecoveryID: offer.RecoveryID, RecoveryKey: offer.RecoveryKey, Authorization: offer.Authorization,
			Transfer: &ScopeOwnershipClaim{CutoverDigest: binding.CutoverDigest, ExpiresAt: offer.ExpiresAt, CandidatesRoot: offer.CandidatesRoot}}
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		if want, _ := sign(ctx, query, actor, draft); !bytes.Equal(want, draft.Signature) {
			return ErrPolicySignatureRequired
		}
		if draft.Action == TransferPolicyOwnership {
			offer, err := ReadOwnerTransferBasis(ctx, query, actor, draft)
			if err != nil {
				return err
			}
			if offer.OwnerProfileID != oldID || offer.TargetProfileID != targetID || len(offer.Candidates) != 2 || offer.RecoveryID != recovery.ID {
				return ErrPolicyConflict
			}
			_, err = VerifyScopeAuthorityChain(binding, scopeAuthorityTestPublicKey(oldKey), []ScopeAuthorityLink{*draft.ResourceChange.OwnershipTransfer})
			return err
		}
		return nil
	}
	mutate := func(actor Principal, request PolicyDraft) PolicyProof {
		t.Helper()
		preview, err := store.PreviewPolicyForTransport(ctx, resolve(actor), request)
		if err != nil {
			t.Fatal(err)
		}
		preview.Draft.Signature, _ = sign(ctx, db, actor, preview.Draft)
		proof, err := store.CommitPolicy(ctx, resolve(actor), verify, preview.Draft)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := mutate(owner, PolicyDraft{Action: AnchorPolicy, OperationID: op(1)})
	binding.AnchorDigest = anchor.Digest
	if _, err := store.PreviewOwnerTransferOffer(ctx, resolve(owner), unrelatedID, op(2), now.Add(time.Minute).UnixMilli()); !errors.Is(err, RecoveryRequired) {
		t.Fatalf("unprepared target accepted: %v", err)
	}
	if _, err := store.PreviewOwnerTransferOffer(ctx, resolve(unrelated), targetID, op(2), now.Add(time.Minute).UnixMilli()); !errors.Is(err, MissingGrant) {
		t.Fatalf("non-owner produced offer: %v", err)
	}
	verifyOffer := func(_ context.Context, _ SessionQuery, actor Principal, offer OwnerTransferOffer) error {
		frame, err := ScopeOwnershipOfferFrame(binding, actor.ProfileID, linkFor(offer))
		signature, decodeErr := base64.RawURLEncoding.DecodeString(offer.Authorization)
		if err != nil || decodeErr != nil || !ed25519.Verify(oldKey.Public().(ed25519.PublicKey), frame, signature) {
			return ErrPolicySignatureRequired
		}
		return nil
	}
	previewOffer := func(index byte) OwnerTransferOffer {
		t.Helper()
		offer, err := store.PreviewOwnerTransferOffer(ctx, resolve(owner), targetID, op(index), now.Add(time.Minute).UnixMilli())
		if err != nil {
			t.Fatal(err)
		}
		offer.Sequence, offer.Previous = 1, binding.AnchorDigest
		frame, err := ScopeOwnershipOfferFrame(binding, oldID, linkFor(offer))
		if err != nil {
			t.Fatal(err)
		}
		offer.Authorization = base64.RawURLEncoding.EncodeToString(ed25519.Sign(oldKey, frame))
		return offer
	}
	create := func(offer OwnerTransferOffer) error {
		_, err := store.CreateOwnerTransferOffer(ctx, resolve(owner), offer, verifyOffer)
		return err
	}
	readOffer := func(actor Principal) OwnerTransferOffer {
		t.Helper()
		var offer OwnerTransferOffer
		if err := store.DispatchOwnerTransferOffer(ctx, resolve(actor), func(pending OwnerTransferOffer) error {
			offer = pending
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return offer
	}
	certifications := 0
	certify := func(_ context.Context, _ SessionQuery, actor Principal, offer OwnerTransferOffer) (ScopeAuthorityLink, error) {
		certifications++
		if actor != accepting {
			return ScopeAuthorityLink{}, MissingGrant
		}
		link := linkFor(offer)
		link.DeviceKey = scopeAuthorityTestPublicKey(acceptingKey)
		keys := []string{offer.Candidates[0].SigningKey, offer.Candidates[1].SigningKey}
		claim, err := ScopeOwnershipCandidateClaim(keys, link.DeviceKey, offer.ExpiresAt)
		if err != nil {
			return ScopeAuthorityLink{}, err
		}
		claim.CutoverDigest = binding.CutoverDigest
		link.Transfer = &claim
		frame, err := ScopeOwnershipAcceptFrame(binding, oldID, link)
		if err != nil {
			return ScopeAuthorityLink{}, err
		}
		link.DeviceProof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(acceptingKey, frame))
		return link, nil
	}
	accept := func(actor Principal, offer OwnerTransferOffer) (PolicyProof, error) {
		return store.CommitOwnerTransfer(ctx, resolve(actor), offer.OperationID, serverKey, certify, sign, verify)
	}
	canceled := previewOffer(2)
	for _, pending := range []OwnerTransferOffer{canceled, canceled} {
		if err := create(pending); err != nil {
			t.Fatal(err)
		}
	}
	if readOffer(unrelated).OperationID != "" || readOffer(firstTarget).OperationID != canceled.OperationID || readOffer(owner).OperationID != canceled.OperationID {
		t.Fatal("offer visibility did not match participants")
	}
	if err := create(previewOffer(3)); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("second concurrent pending offer = %v", err)
	}
	if err := store.CancelOwnerTransferOffer(ctx, resolve(accepting), canceled.OperationID); !errors.Is(err, MissingGrant) {
		t.Fatalf("non-owner canceled offer: %v", err)
	}
	if err := store.CancelOwnerTransferOffer(ctx, resolve(owner), canceled.OperationID); err != nil {
		t.Fatal(err)
	}
	if err := create(canceled); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("canceled offer was resurrected: %v", err)
	}
	expired := previewOffer(3)
	if err := create(expired); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if _, err := accept(accepting, expired); !errors.Is(err, ErrOwnerTransferUnavailable) || readOffer(accepting).OperationID != "" {
		t.Fatalf("expired offer remained available: %v", err)
	}
	stale := previewOffer(4)
	if err := create(stale); err != nil {
		t.Fatal(err)
	}
	mutate(owner, PolicyDraft{Action: UpdatePolicyRoles, OperationID: op(5), RoleUpdate: &RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order}})
	if _, err := accept(accepting, stale); !errors.Is(err, ErrPolicyConflict) || readOffer(accepting).OperationID != "" {
		t.Fatalf("offer survived a policy head change: %v", err)
	}
	current := previewOffer(6)
	if err := create(current); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PreviewPolicy(ctx, resolve(owner), PolicyDraft{Action: TransferPolicyOwnership, OperationID: current.OperationID}); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic owner transfer preview: %v", err)
	}
	before, _, err := store.Snapshot(ctx)
	if err != nil || before.Owner != oldID || before.CanDeliver(targetID, hidden, 0) {
		t.Fatalf("owner or channel access changed before acceptance: owner=%s err=%v", before.Owner, err)
	}
	if _, err := accept(unrelated, current); !errors.Is(err, ErrOwnerTransferUnavailable) {
		t.Fatalf("unrelated acceptance: %v", err)
	}
	proof, err := accept(accepting, current)
	if err != nil || proof.Principal != owner || proof.Draft.ResourceChange.ID != targetID {
		t.Fatalf("eligible acceptance: proof=%+v err=%v", proof, err)
	}
	now = now.Add(time.Hour)
	again, err := accept(accepting, current)
	if err != nil || again.Digest != proof.Digest || certifications != 1 {
		t.Fatalf("retry repeated signing or lost receipt: digest=%s certifications=%d err=%v", again.Digest, certifications, err)
	}
	if _, err := accept(firstTarget, current); !errors.Is(err, ErrOwnerTransferUnavailable) {
		t.Fatalf("other eligible device retrieved receipt: %v", err)
	}
	state, revision, err := store.Snapshot(ctx)
	if err != nil || state.Owner != targetID || revision != 3 || !state.CanDeliver(targetID, hidden, 1) ||
		!slices.Equal(state.Members[oldID].Roles, []string{"reader"}) || len(state.Members[targetID].Roles) != 0 ||
		state.CheckGrant(state.Members[oldID], Scope{}, Administrator, 0) == Allowed ||
		state.CheckGrant(state.Members[targetID], Scope{}, Administrator, 0) != Allowed {
		t.Fatalf("transfer did not update owner/access while preserving roles: owner=%s revision=%d err=%v", state.Owner, revision, err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM protected_audit_events WHERE action=? AND actor=? AND kind='member' AND object_id=?`,
		TransferPolicyOwnership, oldID, targetID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("owner transfer audit count=%d err=%v", count, err)
	}
}
