package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha512"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestDeviceBindingPreservesExistingAccess(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	now := time.UnixMilli(90_000)
	store := NewStoreWithClock(db, func() time.Time { return now })
	ownerID, memberID := strings.Repeat("a", 64), strings.Repeat("b", 64)
	state := State{RoleSnapshot: RoleSnapshot{
		Policy: Policy{Owner: ownerID, Order: []string{"reader"}, Roles: map[string]Role{
			Everyone: {Grants: []string{ChannelView}}, "reader": {Grants: []string{"history.full"}},
		}}, Members: map[string]Subject{
			ownerID: {ID: ownerID, Active: true}, memberID: {ID: memberID, Active: true, Roles: []string{"reader"}},
		},
	}, Channels: map[string]Channel{
		"full":   {Kind: "text", NextPosition: 5},
		"live":   {Kind: "text", NextPosition: 5, ACL: ACL{Profiles: map[string]Overwrite{memberID: {Deny: []string{"history.full"}}}}},
		"hidden": {Kind: "text", NextPosition: 5, ACL: ACL{Profiles: map[string]Overwrite{memberID: {Deny: []string{ChannelView}}}}},
	}, PolicyDevices: make(map[string]PolicyDevice), KeyRecipients: make(map[string]KeyRecipient)}
	principal := func(profile string, seed byte) Principal {
		return Principal{ProfileID: profile, DeviceID: hexHash(scopeAuthorityTestKey(seed).Public().(ed25519.PublicKey))}
	}
	owner, member, priorDevice := principal(ownerID, 1), principal(memberID, 2), principal(memberID, 3)
	for index, actor := range []Principal{owner, member, priorDevice} {
		state.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: actor.ProfileID, PublicKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(byte(index + 1)))}
		state.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, byte(index+20))}
	}
	identity := RecoveryIdentity{ID: strings.Repeat("c", 64), SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(4)), AgreementKey: recoveryTestAgreementKey(t, 23)}
	state.RecoveryIdentities = map[string]RecoveryIdentity{memberID: identity}
	state.KeyRecipients[identity.ID] = KeyRecipient{ProfileID: memberID, Kind: "recovery", PublicKey: identity.AgreementKey}
	state.RecoveryReady = map[string]bool{memberID: true}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		result := sha512.Sum512([]byte(draft.Action + draft.OperationID + draft.ResultDigest + draft.PreviousDigest))
		return result[:], nil
	}
	validateApproval := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		approver, err := ReadDeviceBindingApprover(ctx, query, actor, draft)
		if err != nil {
			return err
		}
		if approver != state.PolicyDevices[member.DeviceID] || draft.ResourceChange.DeviceBinding.ApproverProof != recoveryTestProof(64, 7) {
			return ErrPolicySignatureRequired
		}
		return nil
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		expected, _ := sign(ctx, query, actor, draft)
		if !bytes.Equal(expected, draft.Signature) {
			return ErrPolicySignatureRequired
		}
		if draft.Action == BindPolicyDevice {
			return validateApproval(ctx, query, actor, draft)
		}
		return nil
	}
	preview, err := store.PreviewPolicyForTransport(ctx, resolve(owner), PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	if err != nil {
		t.Fatal(err)
	}
	preview.Draft.Signature, _ = sign(ctx, db, owner, preview.Draft)
	anchor, err := store.CommitPolicy(ctx, resolve(owner), verify, preview.Draft)
	if err != nil {
		t.Fatal(err)
	}
	operational, _, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// Existing epochs let this fixture distinguish new rotation work from the
	// normal bootstrap task for a channel without an epoch.
	operational.EpochWindows = map[string]EpochWindow{"full": {Current: 1}, "live": {Current: 1}, "hidden": {Current: 1}}
	operational.ArchiveHeads = map[string]uint64{"full": 1, "live": 1, "hidden": 1}
	encoded, err := json.Marshal(operational)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE protected_policy SET snapshot=? WHERE id=1; DELETE FROM protected_rotation_tasks", encoded); err != nil {
		t.Fatal(err)
	}
	intent := func(operation byte, previous string, expires time.Time) PolicyDraft {
		return PolicyDraft{Action: BindPolicyDevice, OperationID: fmt.Sprintf("%032x", operation), PreviousDigest: previous,
			ResourceChange: &PolicyResourceChange{ID: memberID, DeviceBinding: &PolicyDeviceBinding{
				SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(5)), AgreementKey: recoveryTestAgreementKey(t, 24),
				CutoverDigest: strings.Repeat("d", 64), Nonce: strings.Repeat("e", 64), ExpiresAt: expires.UnixMilli(),
				ServerAgreementKey: recoveryTestAgreementKey(t, 25), AgreementProof: recoveryTestProof(32, 5),
				ApplicantProof: recoveryTestProof(64, 6), ApproverProof: recoveryTestProof(64, 7), ServerKey: recoveryTestProof(32, 8),
			}}}
	}
	commit := func(actor Principal, draft PolicyDraft) (PolicyProof, error) {
		return store.CommitDeviceBinding(ctx, resolve(actor), draft, validateApproval, sign, verify)
	}
	good := intent(2, anchor.Digest, now.Add(time.Second))
	if _, err := store.PreviewPolicy(ctx, resolve(member), good); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic preview accepted binding: %v", err)
	}
	if _, err := store.CommitPolicy(ctx, resolve(member), verify, good); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic commit accepted binding: %v", err)
	}
	if _, err := commit(owner, good); !errors.Is(err, InvalidAction) {
		t.Fatalf("different profile approved binding: %v", err)
	}
	if _, err := commit(member, intent(3, strings.Repeat("f", 64), now.Add(time.Second))); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("stale head accepted: %v", err)
	}
	if _, err := commit(member, intent(4, anchor.Digest, now)); !errors.Is(err, ErrRecoveryChallengeExpired) {
		t.Fatalf("expired challenge accepted: %v", err)
	}
	wrong := intent(5, anchor.Digest, now.Add(time.Second))
	wrong.ResourceChange.DeviceBinding.ApproverProof = recoveryTestProof(64, 9)
	if _, err := commit(member, wrong); !errors.Is(err, ErrPolicySignatureRequired) {
		t.Fatalf("invalid approver proof accepted: %v", err)
	}
	reused := intent(6, anchor.Digest, now.Add(time.Second))
	reused.ResourceChange.DeviceBinding.AgreementKey = state.KeyRecipients[priorDevice.DeviceID].PublicKey
	if _, err := commit(member, reused); !errors.Is(err, ErrRecipientKey) {
		t.Fatalf("existing agreement key accepted: %v", err)
	}
	proof, err := commit(member, good)
	if err != nil || proof.Principal != member || proof.Draft.Revision != 2 {
		t.Fatalf("valid binding = %+v, err = %v", proof, err)
	}
	now = now.Add(time.Minute)
	if receipt, err := commit(member, good); err != nil || receipt.Digest != proof.Digest {
		t.Fatalf("retry after expiry = %v, err = %v", receipt.Digest, err)
	}
	changed := intent(2, anchor.Digest, time.UnixMilli(good.ResourceChange.DeviceBinding.ExpiresAt))
	changed.ResourceChange.DeviceBinding.ApplicantProof = recoveryTestProof(64, 11)
	if _, err := commit(member, changed); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("altered same-operation intent accepted: %v", err)
	}
	newDevice := principal(memberID, 5)
	current, revision, err := store.Snapshot(ctx)
	if err != nil || revision != 2 || current.Owner != ownerID || !current.hasPolicyDevice(member) || !current.hasPolicyDevice(priorDevice) ||
		!current.hasPolicyDevice(newDevice) || current.KeyRecipients[newDevice.DeviceID] != (KeyRecipient{ProfileID: memberID, Kind: "device", PublicKey: good.ResourceChange.DeviceBinding.AgreementKey}) ||
		current.RecoveryIdentities[memberID] != identity || !current.RecoveryReady[memberID] || !slices.Equal(current.Members[memberID].Roles, []string{"reader"}) ||
		current.EpochWindows["full"] != operational.EpochWindows["full"] || current.Admissions["full"][memberID] != operational.Admissions["full"][memberID] {
		t.Fatalf("ordinary binding did not preserve signed membership or existing epochs: revision=%d err=%v", revision, err)
	}
	rows, err := db.Query(`SELECT channel_id || '/' || purpose FROM protected_rotation_tasks ORDER BY channel_id,purpose`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tasks []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		tasks = append(tasks, name)
	}
	if err := rows.Err(); err != nil || !slices.Equal(tasks, []string{"full/archive", "full/live", "live/live"}) {
		t.Fatalf("rotation tasks = %v, err = %v", tasks, err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM protected_audit_events WHERE action=? AND actor=? AND kind='device' AND object_id=?`,
		BindPolicyDevice, memberID, newDevice.DeviceID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("device bind audit count=%d err=%v", count, err)
	}
}

func TestDeviceBindingReactivatesOnlyExplicitlyDetachedDevices(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	now := time.UnixMilli(10)
	store := NewStoreWithClock(db, func() time.Time { return now })
	initial, owner, primary, source := profileLinkFixture(t)
	initial.PolicyAnchored = false
	otherKey := scopeAuthorityTestKey(65)
	otherID := hexHash(otherKey.Public().(ed25519.PublicKey))
	initial.PolicyDevices[otherID] = PolicyDevice{ProfileID: source.ProfileID, PublicKey: scopeAuthorityTestPublicKey(otherKey)}
	initial.KeyRecipients[otherID] = KeyRecipient{ProfileID: source.ProfileID, PublicKey: recoveryTestAgreementKey(t, 65), Kind: "device"}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		encoded, err := json.Marshal(draft.ResourceChange)
		if err != nil {
			return nil, err
		}
		digest := sha512.Sum512(append([]byte(draft.Action+draft.OperationID+draft.ResultDigest), encoded...))
		return digest[:], nil
	}
	checkApprover := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		_, err := ReadDeviceBindingApprover(ctx, query, actor, draft)
		return err
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		want, err := sign(ctx, query, actor, draft)
		if err != nil || !bytes.Equal(want, draft.Signature) {
			return ErrPolicySignatureRequired
		}
		if draft.Action == BindPolicyDevice {
			return checkApprover(ctx, query, actor, draft)
		}
		return nil
	}
	commit := func(actor Principal, intent PolicyDraft) PolicyProof {
		t.Helper()
		draft, err := store.PreviewPolicy(ctx, resolve(actor), intent)
		if err != nil {
			t.Fatal(err)
		}
		draft.Signature, err = sign(ctx, db, actor, draft)
		if err != nil {
			t.Fatal(err)
		}
		proof, err := store.CommitPolicy(ctx, resolve(actor), verify, draft)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	op := func(index byte) string { return fmt.Sprintf("%032x", index) }
	anchor := commit(owner, PolicyDraft{Action: AnchorPolicy, OperationID: op(1)})
	profileLink := func(action string, operation byte, head PolicyProof, change *PolicyResourceChange) PolicyProof {
		t.Helper()
		proof, err := store.CommitProfileLinking(ctx, resolve(primary), PolicyDraft{Action: action, OperationID: op(operation),
			PreviousDigest: head.Digest, ResourceChange: change}, func(context.Context, SessionQuery, Principal, PolicyDraft) error { return nil },
			sign, verify, func(context.Context, *sql.Tx, Principal, PolicyDraft) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	link := profileLinkClaim(primary, source)
	link.At = 0
	profileLink(LinkPolicyProfiles, 2, anchor, &PolicyResourceChange{ID: primary.ProfileID, ProfileLink: &link})
	manualRevocation := commit(primary, PolicyDraft{Action: RevokePolicyDevice, OperationID: op(3), DeviceChange: &PolicyDeviceChange{DeviceID: otherID}})
	unlink := ProfilePolicyUnlink{CutoverDigest: link.CutoverDigest, ServerKey: link.ServerKey, ExpiresAt: 20, DeviceProof: link.PrimaryProof, GrantDeviceRebind: true}
	detached := profileLink(UnlinkPolicyProfile, 4, manualRevocation, &PolicyResourceChange{ID: source.ProfileID, ProfileUnlink: &unlink})
	if origin, err := ReadDeviceBindingDetachedSource(ctx, db, source.DeviceID); err != nil || origin != source.ProfileID {
		t.Fatalf("explicit detach did not authorize source: origin=%s, err=%v", origin, err)
	}
	if origin, err := ReadDeviceBindingDetachedSource(ctx, db, otherID); err != nil || origin != "" {
		t.Fatalf("previously revoked sibling became eligible: origin=%s, err=%v", origin, err)
	}
	bindIntent := func(opIndex byte, predecessor PolicyProof, key, agreement string) PolicyDraft {
		return PolicyDraft{Action: BindPolicyDevice, OperationID: op(opIndex), PreviousDigest: predecessor.Digest,
			ResourceChange: &PolicyResourceChange{ID: primary.ProfileID, DeviceBinding: &PolicyDeviceBinding{
				SigningKey: key, AgreementKey: agreement, CutoverDigest: link.CutoverDigest, Nonce: strings.Repeat("f", 64),
				ExpiresAt: now.Add(time.Second).UnixMilli(), ServerAgreementKey: recoveryTestAgreementKey(t, 66), AgreementProof: recoveryTestProof(32, 7),
				ApplicantProof: recoveryTestProof(64, 8), ApproverProof: recoveryTestProof(64, 9), ServerKey: link.ServerKey,
			}}}
	}
	bind := func(intent PolicyDraft) (PolicyProof, error) {
		return store.CommitDeviceBinding(ctx, resolve(primary), intent, checkApprover, sign, verify)
	}
	agreement := recoveryTestAgreementKey(t, 67)
	if _, err := bind(bindIntent(5, detached, scopeAuthorityTestPublicKey(otherKey), agreement)); !errors.Is(err, ErrRecipientKey) {
		t.Fatalf("manually revoked sibling was rebound: %v", err)
	}
	sourceKey := initial.PolicyDevices[source.DeviceID].PublicKey
	if _, err := bind(bindIntent(6, detached, sourceKey, initial.KeyRecipients[source.DeviceID].PublicKey)); !errors.Is(err, ErrRecipientKey) {
		t.Fatalf("rebind reused previously retired agreement key: %v", err)
	}
	forgedTime := bindIntent(7, detached, sourceKey, agreement)
	forgedTime.ResourceChange.DeviceBinding.RebindAt = now.UnixMilli()
	if _, err := bind(forgedTime); !errors.Is(err, InvalidAction) {
		t.Fatalf("client supplied rebind time accepted: %v", err)
	}
	banState, _, err := store.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	banState.MemberRemovals = map[string]MemberRemoval{source.ProfileID: {Action: BanPolicyMember, ExpiresAt: now.Add(time.Minute).UnixMilli()}}
	var banned MemberBanError
	if _, err := banState.checkDeviceBinding(primary, forgedTime.ResourceChange); !errors.As(err, &banned) {
		t.Fatalf("signed rebind would bypass a source ban: %v", err)
	}
	bindRequest := bindIntent(8, detached, sourceKey, agreement)
	proof, err := bind(bindRequest)
	if err != nil || proof.Draft.ResourceChange.DeviceBinding.RebindAt != now.UnixMilli() || bindRequest.ResourceChange.DeviceBinding.RebindAt != 0 {
		t.Fatalf("explicit rebind did not sign server time: %v", err)
	}
	applicant := Principal{ProfileID: primary.ProfileID, DeviceID: source.DeviceID}
	state, revision, err := store.Snapshot(ctx)
	if err != nil || revision != proof.Draft.Revision || !state.matchesDeviceBinding(applicant, *proof.Draft.ResourceChange.DeviceBinding) ||
		state.ProfileBindings[source.ProfileID] != primary.ProfileID || state.ProfileDeviceOrigins[source.DeviceID] != source.ProfileID ||
		state.Members[source.ProfileID].Active || len(state.Members[source.ProfileID].Roles) != 0 || state.DetachedPolicyDevices[source.DeviceID] != "" {
		t.Fatalf("rebind did not consume marker and preserve dormant source: %v", err)
	}
	if receipt, err := ReadDeviceBindingReceipt(ctx, db, applicant, bindRequest.OperationID); err != nil || receipt.Digest != proof.Digest {
		t.Fatalf("applicant did not receive current binding receipt: %v", err)
	}
	if _, err := ReadDeviceBindingReceipt(ctx, db, source, bindRequest.OperationID); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("binding receipt accepted the original profile as effective: %v", err)
	}
	now = now.Add(2 * time.Second)
	if receipt, err := bind(bindRequest); err != nil || receipt.Digest != proof.Digest {
		t.Fatalf("exact retry after expiry did not match annotated receipt: %v", err)
	}
	finalRevocation := commit(primary, PolicyDraft{Action: RevokePolicyDevice, OperationID: op(9), DeviceChange: &PolicyDeviceChange{DeviceID: source.DeviceID}})
	if _, err := ReadDeviceBindingReceipt(ctx, db, applicant, bindRequest.OperationID); !errors.Is(err, Inactive) {
		t.Fatalf("revoked device still received active binding receipt: %v", err)
	}
	if _, err := bind(bindIntent(10, finalRevocation, sourceKey, recoveryTestAgreementKey(t, 68))); !errors.Is(err, ErrRecipientKey) {
		t.Fatalf("consumed detach marker reauthorized a manually revoked key: %v", err)
	}
}
