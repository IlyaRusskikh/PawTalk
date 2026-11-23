package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha512"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestRecoveryDeviceTransitionKeepsCurrentAccess(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	now := time.UnixMilli(12_000)
	store := NewStoreWithClock(db, func() time.Time { return now })
	ownerID, memberID := strings.Repeat("a", 64), strings.Repeat("b", 64)
	member := Subject{ID: memberID, Active: true, Roles: []string{"admin"}, TimeoutUntil: now.Add(time.Hour).UnixMilli()}
	initial := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: ownerID, Order: []string{"reader", "admin"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView}},
				"reader": {Grants: []string{"history.full"}},
				"admin":  {Grants: []string{Administrator}},
			}},
			Members: map[string]Subject{ownerID: {ID: ownerID, Active: true}, memberID: member},
		},
		Channels: map[string]Channel{
			"public": {Kind: "text", NextPosition: 10},
			"hidden": {Kind: "text", NextPosition: 10, ACL: ACL{Profiles: map[string]Overwrite{memberID: {Deny: []string{ChannelView}}}}},
			"voice":  {Kind: "voice", NextPosition: 1},
		},
		VoiceRestrictions: map[string]map[string]VoiceRestriction{"voice": {memberID: {Muted: true}}},
		PolicyDevices:     make(map[string]PolicyDevice),
		KeyRecipients:     make(map[string]KeyRecipient),
	}
	newSigner := func(seed byte) string {
		key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
		return hex.EncodeToString(key)
	}
	deviceID := func(key string) string {
		raw, _ := hex.DecodeString(key)
		return hexHash(raw)
	}
	addDevice := func(profile string, seed byte) Principal {
		t.Helper()
		key := newSigner(seed)
		actor := Principal{ProfileID: profile, DeviceID: deviceID(key)}
		initial.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: profile, PublicKey: key}
		initial.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: recoveryTestAgreementKey(t, seed+20)}
		return actor
	}
	owner := addDevice(ownerID, 1)
	lost := []Principal{addDevice(memberID, 2), addDevice(memberID, 3)}
	identity := RecoveryIdentity{ID: strings.Repeat("c", 64), SigningKey: newSigner(4), AgreementKey: recoveryTestAgreementKey(t, 24)}
	initial.RecoveryIdentities = map[string]RecoveryIdentity{memberID: identity}
	initial.KeyRecipients[identity.ID] = KeyRecipient{ProfileID: memberID, Kind: "recovery", PublicKey: identity.AgreementKey}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE fixture_recovery_mappings(device_id TEXT PRIMARY KEY); CREATE TABLE protected_runtime_sessions(device_id TEXT)"); err != nil {
		t.Fatal(err)
	}
	resolveOwner := func(context.Context, SessionQuery) (Principal, error) { return owner, nil }
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		signature := sha512.Sum512([]byte(draft.OperationID + draft.ResultDigest))
		return signature[:], nil
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		expected, _ := sign(ctx, query, actor, draft)
		if !bytes.Equal(expected, draft.Signature) {
			return ErrPolicySignatureRequired
		}
		if draft.Action == RecoverPolicyDevice {
			prior, err := ReadRecoveryDeviceIdentity(ctx, query, actor, draft)
			if err != nil {
				return err
			}
			if prior != identity {
				return ErrPolicyConflict
			}
		}
		return nil
	}
	commitPolicy := func(intent PolicyDraft) PolicyProof {
		t.Helper()
		preview, err := store.PreviewPolicyForTransport(ctx, resolveOwner, intent)
		if err != nil {
			t.Fatal(err)
		}
		preview.Draft.Signature, _ = sign(ctx, db, owner, preview.Draft)
		proof, err := store.CommitPolicy(ctx, resolveOwner, verify, preview.Draft)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := commitPolicy(PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	downgraded := commitPolicy(PolicyDraft{Action: UpdatePolicyRoles, OperationID: strings.Repeat("2", 32),
		RoleUpdate: &RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order, Assignments: map[string][]string{memberID: {"reader"}}}})
	applied := func() State {
		t.Helper()
		state, _, err := readState(db.QueryRow("SELECT revision,snapshot FROM protected_policy WHERE id=1"))
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := applied()
	operational := before
	operational.EpochWindows = map[string]EpochWindow{"public": {Current: 1}, "hidden": {Current: 1}}
	operational.ArchiveHeads = map[string]uint64{"public": 1, "hidden": 1}
	raw, err := json.Marshal(operational)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE protected_policy SET snapshot=? WHERE id=1; DELETE FROM protected_rotation_tasks", raw); err != nil {
		t.Fatal(err)
	}
	intent := func(i byte, previous string) PolicyDraft {
		t.Helper()
		return PolicyDraft{Action: RecoverPolicyDevice, OperationID: fmt.Sprintf("%032x", i), PreviousDigest: previous,
			ResourceChange: &PolicyResourceChange{ID: memberID, RecoveryDevice: &RecoveryPolicyDevice{
				RecoveryID: identity.ID, CutoverDigest: strings.Repeat("e", 64), ServerKey: recoveryTestProof(32, 1),
				Nonce: fmt.Sprintf("%064x", i+10), ExpiresAt: now.Add(time.Second).UnixMilli(),
				SigningKey: newSigner(i), AgreementKey: recoveryTestAgreementKey(t, i+20),
				RecoveryProof: recoveryTestProof(64, 2), AgreementProof: recoveryTestProof(32, 3), DeviceProof: recoveryTestProof(64, 4),
			}}}
	}
	verifyIntent := func(context.Context, SessionQuery, Principal, PolicyDraft) error { return nil }
	syncMembership := func(ctx context.Context, tx *sql.Tx, actor Principal) error {
		state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
		if err != nil {
			return err
		}
		if !state.hasPolicyDevice(actor) || !state.PolicyDevices[lost[0].DeviceID].Revoked || !state.PolicyDevices[lost[1].DeviceID].Revoked {
			return errors.New("membership sync ran before policy state transition")
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO fixture_recovery_mappings VALUES(?)", actor.DeviceID)
		return err
	}
	recover := func(draft PolicyDraft) (PolicyProof, error) {
		t.Helper()
		return store.CommitRecoveryDevice(ctx, draft, verifyIntent, sign, verify, syncMembership)
	}
	if _, err := recover(intent(6, anchor.Digest)); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("old role snapshot authorized recovery: %v", err)
	}
	first := intent(6, downgraded.Digest)
	if _, err := store.PreviewPolicy(ctx, resolveOwner, first); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic preview accepted device recovery: %v", err)
	}
	if _, err := store.CommitPolicy(ctx, resolveOwner, verify, first); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic commit accepted device recovery: %v", err)
	}
	failedSync := errors.New("fixture membership sync failed")
	if _, err := store.CommitRecoveryDevice(ctx, first, verifyIntent, sign, verify,
		func(ctx context.Context, tx *sql.Tx, actor Principal) error {
			if err := syncMembership(ctx, tx, actor); err != nil {
				return err
			}
			return failedSync
		}); !errors.Is(err, failedSync) {
		t.Fatalf("failed sync was accepted: %v", err)
	}
	if state, err := ReadPolicyHead(ctx, db, &lost[0]); err != nil || state.Digest != downgraded.Digest {
		t.Fatalf("failure changed policy or revoked a device: %v", err)
	}
	count := func(table string) int {
		t.Helper()
		var rows int
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&rows); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	if count("fixture_recovery_mappings") != 0 || count("protected_rotation_tasks") != 0 {
		t.Fatal("failed sync escaped transaction")
	}
	proof, err := recover(first)
	if err != nil {
		t.Fatal(err)
	}
	state := applied()
	firstDevice := deviceID(first.ResourceChange.RecoveryDevice.SigningKey)
	if proof.Principal != (Principal{ProfileID: memberID, DeviceID: firstDevice}) ||
		!state.hasPolicyDevice(proof.Principal) || !slices.Equal(state.Members[memberID].Roles, []string{"reader"}) ||
		state.Members[memberID].TimeoutUntil != member.TimeoutUntil || state.RecoveryReady[memberID] ||
		state.RecoveryIdentities[memberID] != identity || state.KeyRecipients[identity.ID] != initial.KeyRecipients[identity.ID] ||
		state.Admissions["public"][memberID] != before.Admissions["public"][memberID] ||
		state.VoiceRestrictions["voice"][memberID] != before.VoiceRestrictions["voice"][memberID] ||
		state.EpochWindows["public"].CurrentCutoff != now.UnixMilli()+graceMillis || state.EpochWindows["hidden"].CurrentCutoff != 0 {
		t.Fatal("device recovery changed roles, admission, existing recovery or unrelated channel grace")
	}
	for _, old := range lost {
		if !state.PolicyDevices[old.DeviceID].Revoked || state.KeyRecipients[old.DeviceID].Kind != "" ||
			!state.RetiredRecipientKeys[initial.KeyRecipients[old.DeviceID].PublicKey] {
			t.Fatal("old device or agreement key was not retired")
		}
	}
	if !state.hasPolicyDevice(owner) || count("protected_rotation_tasks") != 2 || count("fixture_recovery_mappings") != 1 {
		t.Fatal("recovery affected another member or missed its rotation tasks")
	}
	now = now.Add(2 * time.Second)
	blockedRetry := errors.New("fixture inherited ban")
	if _, err := store.CommitRecoveryDevice(ctx, first,
		func(context.Context, SessionQuery, Principal, PolicyDraft) error { return blockedRetry }, sign, verify, syncMembership); !errors.Is(err, blockedRetry) {
		t.Fatalf("exact retry bypassed current transport authentication: %v", err)
	}
	if repeated, err := recover(first); err != nil || repeated.Digest != proof.Digest || count("fixture_recovery_mappings") != 1 {
		t.Fatalf("expired exact retry failed or repeated side effects: %v", err)
	}
	wrongID := intent(7, proof.Digest)
	wrongID.ResourceChange.RecoveryDevice.RecoveryID = strings.Repeat("f", 64)
	if _, err := recover(wrongID); !errors.Is(err, ErrRecipientKey) {
		t.Fatalf("mismatched recovery identity did not use the expected authentication result: %v", err)
	}
	second := intent(7, proof.Digest)
	next, err := recover(second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := recover(first); !errors.Is(err, Inactive) {
		t.Fatalf("an already replaced recovered device could replay its receipt: %v", err)
	}
	reuse := intent(8, next.Digest)
	reuse.ResourceChange.RecoveryDevice.AgreementKey = first.ResourceChange.RecoveryDevice.AgreementKey
	if _, err := recover(reuse); !errors.Is(err, ErrRecipientKey) {
		t.Fatalf("retired agreement key was reused: %v", err)
	}
	ban := PolicyDraft{Action: BanPolicyMember, OperationID: strings.Repeat("b", 32), PreviousDigest: next.Digest,
		ResourceChange: &PolicyResourceChange{ID: memberID, Departure: &MemberPolicyDeparture{
			CutoverDigest: strings.Repeat("e", 64), Reason: "Fixture ban",
		}}}
	banned, err := store.CommitMemberDeparture(ctx, owner, ban, resolveOwner, nil, verifyIntent, sign, verify)
	if err != nil {
		t.Fatal(err)
	}
	for _, denied := range []PolicyDraft{second, intent(9, banned.Digest)} {
		var banErr MemberBanError
		if _, err := recover(denied); !errors.As(err, &banErr) {
			t.Fatalf("banned profile could recover or replay: %v", err)
		}
	}
	var audits int
	if err := db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE action='recovery.device' AND actor=?", memberID).Scan(&audits); err != nil || audits != 2 {
		t.Fatalf("recovery audit entries: %d, %v", audits, err)
	}
	replay, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer replay.Rollback()
	if err := VerifyActivatedPolicyChain(ctx, replay, anchor.Digest, owner, verify); err != nil {
		t.Fatalf("historical recovery proofs no longer replay after replacement and ban: %v", err)
	}
}

func TestRecoveryDeviceReadinessAppliesToOwner(t *testing.T) {
	state := testPolicyState()
	state.PolicyAnchored = true
	state.Roles["reader"] = Role{Grants: []string{Administrator}}
	state.RecoveryIdentities = map[string]RecoveryIdentity{
		"owner":  {ID: "owner-recovery", SigningKey: "owner-signing", AgreementKey: "owner-agreement"},
		"reader": {ID: "reader-recovery", SigningKey: "reader-signing", AgreementKey: "reader-agreement"},
	}
	state.KeyRecipients = map[string]KeyRecipient{
		"owner-recovery":  {ProfileID: "owner", Kind: "recovery", PublicKey: "owner-agreement"},
		"reader-recovery": {ProfileID: "reader", Kind: "recovery", PublicKey: "reader-agreement"},
	}
	if _, err := state.recoveryDeviceIdentity("owner", 1); !errors.Is(err, RecoveryRequired) {
		t.Fatalf("owner recovered before confirming recovery readiness: %v", err)
	}
	if _, err := state.recoveryDeviceIdentity("reader", 1); err != nil {
		t.Fatalf("existing Administrator lost account recovery due to a pending packet: %v", err)
	}
	state.RecoveryReady = map[string]bool{"owner": true}
	if _, err := state.recoveryDeviceIdentity("owner", 1); err != nil {
		t.Fatalf("ready owner could not recover: %v", err)
	}
}
