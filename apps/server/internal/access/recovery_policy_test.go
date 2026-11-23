package access

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
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

func TestRecoveryEnrollmentTransactions(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	now := time.UnixMilli(10_000)
	store := NewStoreWithClock(db, func() time.Time { return now })
	profile, owner := strings.Repeat("b", 64), strings.Repeat("a", 64)
	ownerActor := Principal{ProfileID: owner}
	reader := Principal{ProfileID: profile}
	initial := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner, Order: []string{"reader"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView}},
				"reader": {Grants: []string{"history.full"}},
			}},
			Members: map[string]Subject{
				owner:   {ID: owner, Active: true},
				profile: {ID: profile, Active: true, Roles: []string{"reader"}},
			},
		},
		Channels: map[string]Channel{
			"public": {Kind: "text", NextPosition: 7},
			"limited": {Kind: "text", NextPosition: 7, ACL: ACL{
				Profiles: map[string]Overwrite{profile: {Deny: []string{"history.full"}}},
			}},
			"hidden": {Kind: "text", NextPosition: 7, ACL: ACL{
				Profiles: map[string]Overwrite{profile: {Deny: []string{ChannelView}}},
			}},
		},
		PolicyDevices: make(map[string]PolicyDevice, 2),
		KeyRecipients: make(map[string]KeyRecipient, 2),
	}
	for i, actor := range []*Principal{&ownerActor, &reader} {
		public := sha256.Sum256([]byte(actor.ProfileID))
		actor.DeviceID = hexHash(public[:])
		initial.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: actor.ProfileID, PublicKey: hex.EncodeToString(public[:])}
		initial.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, byte(i+1))}
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	resolveOwner, resolveReader := resolve(ownerActor), resolve(reader)
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		signature := sha512.Sum512([]byte(draft.OperationID + draft.ResultDigest))
		return signature[:], nil
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		expected, _ := sign(ctx, query, actor, draft)
		if !bytes.Equal(expected, draft.Signature) {
			return ErrPolicySignatureRequired
		}
		return nil
	}
	anchor, err := store.PreviewPolicyForTransport(ctx, resolveOwner, PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	if err != nil {
		t.Fatal(err)
	}
	anchor.Draft.Signature, _ = sign(ctx, db, ownerActor, anchor.Draft)
	head, err := store.CommitPolicy(ctx, resolveOwner, verify, anchor.Draft)
	if err != nil {
		t.Fatal(err)
	}
	applied := func() State {
		t.Helper()
		state, _, err := readState(db.QueryRow("SELECT revision,snapshot FROM protected_policy WHERE id=1"))
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	saveCompletedGenerations := func(state State) {
		t.Helper()
		// The operational generations do not affect the signed snapshot.
		// Pretend existing rotations have completed to exercise re-enqueue.
		state.EpochWindows = map[string]EpochWindow{"public": {Current: 1}, "limited": {Current: 1}, "hidden": {Current: 1}}
		state.ArchiveHeads = map[string]uint64{"public": 1, "limited": 1, "hidden": 1}
		raw, err := json.Marshal(state)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("UPDATE protected_policy SET snapshot=? WHERE id=1; DELETE FROM protected_rotation_tasks", raw); err != nil {
			t.Fatal(err)
		}
	}
	intent := func(i int, previous string) PolicyDraft {
		t.Helper()
		return PolicyDraft{Action: EnrollPolicyRecovery, OperationID: fmt.Sprintf("%032x", i), PreviousDigest: previous,
			ResourceChange: &PolicyResourceChange{ID: profile, Recovery: &RecoveryPolicyEnrollment{
				RecoveryID: fmt.Sprintf("%064x", i+100), SigningKey: fmt.Sprintf("%064x", i+200),
				AgreementKey: recoveryTestAgreementKey(t, byte(i+10)), CutoverDigest: strings.Repeat("c", 64),
				ServerKey: recoveryTestProof(32, 1), Nonce: fmt.Sprintf("%064x", i+300), ExpiresAt: now.Add(time.Second).UnixMilli(),
				ServerAgreementKey: recoveryTestAgreementKey(t, 50), RecoveryProof: recoveryTestProof(64, 2),
				AgreementProof: recoveryTestProof(32, 3), DeviceProof: recoveryTestProof(64, 4),
			}}}
	}
	saveCompletedGenerations(applied())
	first := intent(2, head.Digest)
	fresh := 0
	verifyIntent := func(context.Context, SessionQuery, Principal, PolicyDraft) error {
		fresh++
		return nil
	}
	if _, err := store.PreviewPolicy(ctx, resolveReader, first); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic preview accepted a recovery intent: %v", err)
	}
	if _, err := store.CommitPolicy(ctx, resolveReader, verify, first); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic commit accepted a recovery intent: %v", err)
	}
	if _, err := store.CommitRecoveryEnrollment(ctx, resolveOwner, first, verifyIntent, sign, verify); !errors.Is(err, InvalidAction) {
		t.Fatalf("enabled recovery for another profile: %v", err)
	}
	denied := func(context.Context, SessionQuery, Principal, PolicyDraft) error { return ErrPolicySignatureRequired }
	if _, err := store.CommitRecoveryEnrollment(ctx, resolveReader, first, denied, sign, verify); !errors.Is(err, ErrPolicySignatureRequired) {
		t.Fatalf("failed ownership proof was accepted: %v", err)
	}
	prior, err := store.CommitRecoveryEnrollment(ctx, resolveReader, first, verifyIntent, sign, verify)
	if err != nil {
		t.Fatal(err)
	}
	state := applied()
	firstRecovery := first.ResourceChange.Recovery
	if state.RecoveryIdentities[profile].ID != firstRecovery.RecoveryID || !state.validState() ||
		state.RecoveryReady[profile] || !slices.Equal(state.Members[profile].Roles, []string{"reader"}) ||
		state.Admissions["limited"][profile].FirstPosition != 7 {
		t.Fatal("enrollment changed readiness, roles or the original admission boundary")
	}
	archive, err := state.rotationRecipients("public", ArchiveEpoch)
	if err != nil || archive[firstRecovery.RecoveryID].Kind != "recovery" {
		t.Fatalf("full-history recovery omitted from archive: %v", err)
	}
	limitedArchive, err := state.rotationRecipients("limited", ArchiveEpoch)
	if err != nil || limitedArchive[firstRecovery.RecoveryID].Kind != "" {
		t.Fatalf("limited-history recovery entered archive: %v", err)
	}
	limitedLive, err := state.rotationRecipients("limited", LiveEpoch)
	if err != nil || limitedLive[firstRecovery.RecoveryID].Kind != "recovery" {
		t.Fatalf("limited-history recovery omitted from new live: %v", err)
	}
	if state.EpochWindows["public"].CurrentCutoff != 0 {
		t.Fatal("new unexposed recovery identity shortened the previous live key")
	}
	assertRotations := func(revision int64) {
		t.Helper()
		var total, applicable int
		err := db.QueryRow(`SELECT COUNT(*),COUNT(CASE WHEN channel_id IN ('public','limited') AND revision=? THEN 1 END)
			FROM protected_rotation_tasks`, revision).Scan(&total, &applicable)
		if err != nil || total != 4 || applicable != 4 {
			t.Fatalf("affected live and archive tasks: %d/%d, %v", applicable, total, err)
		}
	}
	assertRotations(prior.Draft.Revision)
	roles := state.Roles
	roles["reader"] = Role{Grants: []string{Administrator}}
	_, err = store.PreviewPolicy(ctx, resolveOwner, PolicyDraft{Action: UpdatePolicyRoles, OperationID: strings.Repeat("d", 32),
		RoleUpdate: &RolePolicyUpdate{Roles: roles, Order: state.Order}})
	var unmet RoleChangeFailure
	if !errors.As(err, &unmet) || unmet.Decision != RecoveryRequired ||
		!slices.Equal(unmet.RecoveryProfiles, []string{profile}) {
		t.Fatalf("pending recovery bypassed Administrator readiness: %v", err)
	}

	now = now.Add(2 * time.Second)
	repeated, err := store.CommitRecoveryEnrollment(ctx, resolveReader, first, verifyIntent, sign, verify)
	if err != nil || repeated.Digest != prior.Digest || fresh != 1 {
		t.Fatalf("exact retry revalidated an expired challenge or added a policy transition: %v", err)
	}
	expired := intent(8, prior.Digest)
	expired.ResourceChange.Recovery.ExpiresAt = now.UnixMilli()
	if _, err := store.CommitRecoveryEnrollment(ctx, resolveReader, expired, verifyIntent, sign, verify); !errors.Is(err, ErrRecoveryChallengeExpired) {
		t.Fatalf("new expired challenge did not fail closed: %v", err)
	}
	if _, err := store.CommitRecoveryEnrollment(ctx, resolveReader, intent(3, head.Digest), verifyIntent, sign, verify); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("approved enrollment on a stale head: %v", err)
	}
	mismatch := first
	differentProof := *firstRecovery
	differentProof.DeviceProof = recoveryTestProof(64, 5)
	mismatch.ResourceChange = &PolicyResourceChange{ID: profile, Recovery: &differentProof}
	if _, err := store.CommitRecoveryEnrollment(ctx, resolveReader, mismatch, verifyIntent, sign, verify); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("changed request reused the original receipt: %v", err)
	}
	saveCompletedGenerations(applied())
	late := intent(9, prior.Digest)
	beforeSign := now
	lateSign := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) ([]byte, error) {
		now = time.UnixMilli(late.ResourceChange.Recovery.ExpiresAt)
		return sign(ctx, query, actor, draft)
	}
	if _, err := store.CommitRecoveryEnrollment(ctx, resolveReader, late, verifyIntent, lateSign, verify); !errors.Is(err, ErrRecoveryChallengeExpired) {
		t.Fatalf("challenge that expired during commit was accepted: %v", err)
	}
	now = beforeSign
	if current, err := ReadPolicyHead(ctx, db, &reader); err != nil || current.Digest != prior.Digest {
		t.Fatalf("late enrollment advanced the policy head: %v", err)
	}
	second := intent(4, prior.Digest)
	next, err := store.CommitRecoveryEnrollment(ctx, resolveReader, second, verifyIntent, sign, verify)
	if err != nil {
		t.Fatal(err)
	}
	state = applied()
	assertRotations(next.Draft.Revision)
	secondRecovery := second.ResourceChange.Recovery
	if state.RecoveryIdentities[profile].ID != secondRecovery.RecoveryID || state.KeyRecipients[firstRecovery.RecoveryID].Kind != "" ||
		!state.RetiredRecipientKeys[firstRecovery.AgreementKey] || !state.RetiredRecoverySigningKeys[firstRecovery.SigningKey] ||
		state.EpochWindows["public"].CurrentCutoff != now.UnixMilli()+graceMillis || state.EpochWindows["hidden"].CurrentCutoff != 0 ||
		state.RecoveryReady[profile] {
		t.Fatal("replacement did not retire the former identity and bound the grace of affected channels")
	}
	reuse := intent(5, next.Digest)
	reuse.ResourceChange.Recovery.SigningKey = firstRecovery.SigningKey
	if _, err := store.CommitRecoveryEnrollment(ctx, resolveReader, reuse, verifyIntent, sign, verify); !errors.Is(err, ErrRecipientKey) {
		t.Fatalf("old recovery signer was reusable: %v", err)
	}
	reuse.ResourceChange.Recovery.SigningKey = strings.Repeat("7", 64)
	reuse.ResourceChange.Recovery.AgreementKey = firstRecovery.AgreementKey
	if _, err := store.CommitRecoveryEnrollment(ctx, resolveReader, reuse, verifyIntent, sign, verify); !errors.Is(err, ErrRecipientKey) {
		t.Fatalf("old recovery agreement key was reusable: %v", err)
	}
	rows, err := db.Query("SELECT action,actor,object_id FROM protected_audit_events ORDER BY sequence")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var events []string
	for rows.Next() {
		var action, actor, object string
		if err := rows.Scan(&action, &actor, &object); err != nil {
			t.Fatal(err)
		}
		if actor != profile || object != profile {
			t.Fatalf("recovery event exposed more than the member: %s, %s", actor, object)
		}
		events = append(events, action)
	}
	if err := rows.Err(); err != nil || !slices.Equal(events, []string{"recovery.enroll", "recovery.replace"}) {
		t.Fatalf("wrong audit entries: %v, %v", events, err)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE protected_runtime_sessions(device_id TEXT)"); err != nil {
		t.Fatal(err)
	}
	ban := PolicyDraft{Action: BanPolicyMember, OperationID: strings.Repeat("b", 32), PreviousDigest: next.Digest,
		ResourceChange: &PolicyResourceChange{ID: profile, Departure: &MemberPolicyDeparture{
			CutoverDigest: strings.Repeat("c", 64), Reason: "Fixture ban",
		}}}
	banned, err := store.CommitMemberDeparture(ctx, ownerActor, ban, resolveOwner, nil, verifyIntent, sign, verify)
	if err != nil {
		t.Fatal(err)
	}
	state = applied()
	if state.Members[profile].Active || state.RecoveryIdentities[profile].ID != "" ||
		state.KeyRecipients[secondRecovery.RecoveryID].Kind != "" || !state.RetiredRecoverySigningKeys[secondRecovery.SigningKey] {
		t.Fatal("ban did not retire the member's current recovery identity")
	}
	for _, denied := range []PolicyDraft{second, intent(6, banned.Digest)} {
		if _, err := store.CommitRecoveryEnrollment(ctx, resolveReader, denied, verifyIntent, sign, verify); !errors.Is(err, Inactive) {
			t.Fatalf("banned profile could replay or create a recovery identity: %v", err)
		}
	}
}

func recoveryTestAgreementKey(t *testing.T, seed byte) string {
	t.Helper()
	key, err := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{seed}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(key.PublicKey().Bytes())
}

func recoveryTestProof(size int, value byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, size))
}
