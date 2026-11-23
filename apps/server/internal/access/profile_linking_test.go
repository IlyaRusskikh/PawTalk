package access

import (
	"bytes"
	"context"
	"crypto/sha512"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func profileLinkFixture(t *testing.T) (State, Principal, Principal, Principal) {
	t.Helper()
	state := State{RoleSnapshot: RoleSnapshot{
		Policy: Policy{Roles: map[string]Role{Everyone: {}, "reader": {Grants: []string{ChannelView}}, "writer": {Grants: []string{ChannelView, "history.full", "message.send"}}},
			Order: []string{"reader", "writer"}}, Members: make(map[string]Subject)},
		PolicyAnchored: true, PolicyDevices: make(map[string]PolicyDevice), KeyRecipients: make(map[string]KeyRecipient),
		RecoveryIdentities: make(map[string]RecoveryIdentity), RecoveryReady: make(map[string]bool),
		MemberRemovals: make(map[string]MemberRemoval), Categories: make(map[string]ACL), Channels: make(map[string]Channel)}
	register := func(seed byte, profile, role string) Principal {
		t.Helper()
		key := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(seed))
		decoded, err := hex.DecodeString(key)
		if err != nil {
			t.Fatal(err)
		}
		actor := Principal{ProfileID: profile, DeviceID: hexHash(decoded)}
		state.Members[actor.ProfileID] = Subject{ID: actor.ProfileID, Active: true, Roles: []string{role}}
		state.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: actor.ProfileID, PublicKey: key}
		state.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, seed)}
		return actor
	}
	owner := register(61, strings.Repeat("a", 64), "writer")
	primary := register(62, strings.Repeat("b", 64), "reader")
	secondary := register(63, strings.Repeat("c", 64), "writer")
	state.Owner = owner.ProfileID
	return state, owner, primary, secondary
}

func profileLinkClaim(primary, secondary Principal) ProfilePolicyLink {
	return ProfilePolicyLink{SecondaryProfileID: secondary.ProfileID, PrimaryDeviceID: primary.DeviceID, SecondaryDeviceID: secondary.DeviceID,
		CutoverDigest: strings.Repeat("1", 64), ServerKey: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32)), At: 10, ExpiresAt: 20,
		PrimaryProof:   base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 64)),
		SecondaryProof: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{4}, 64))}
}

func TestProfileLinkSelectsPrimaryRightsAndUnlinkDoesNotReadmit(t *testing.T) {
	state, _, primary, secondary := profileLinkFixture(t)
	state.Categories["category"] = ACL{Profiles: map[string]Overwrite{secondary.ProfileID: {Allow: []string{ChannelView}}}}
	state.CategoryCreators = map[string]string{"category": secondary.ProfileID}
	state.Channels["room"] = Channel{Kind: "text", NextPosition: 2, ACL: ACL{
		Profiles: map[string]Overwrite{secondary.ProfileID: {Allow: []string{"message.send"}, Deny: []string{"history.full"}}}}}
	recovery := RecoveryIdentity{ID: strings.Repeat("d", 64), SigningKey: scopeAuthorityTestPublicKey(scopeAuthorityTestKey(64)),
		AgreementKey: recoveryTestAgreementKey(t, 64)}
	state.RecoveryIdentities[secondary.ProfileID] = recovery
	state.RecoveryReady[secondary.ProfileID] = true
	state.KeyRecipients[recovery.ID] = KeyRecipient{ProfileID: secondary.ProfileID, Kind: "recovery", PublicKey: recovery.AgreementKey}
	agreement := state.KeyRecipients[secondary.DeviceID].PublicKey
	claim := profileLinkClaim(primary, secondary)
	if err := state.applyProfileLink(primary, claim); err != nil {
		t.Fatal(err)
	}
	if state.Members[secondary.ProfileID].Active || len(state.Members[secondary.ProfileID].Roles) != 0 ||
		!slices.Equal(state.Members[primary.ProfileID].Roles, []string{"reader"}) || state.PolicyDevices[secondary.DeviceID].ProfileID != primary.ProfileID ||
		state.KeyRecipients[secondary.DeviceID] != (KeyRecipient{ProfileID: primary.ProfileID, Kind: "device", PublicKey: agreement}) ||
		state.ProfileDeviceOrigins[secondary.DeviceID] != secondary.ProfileID || state.ProfileBindings[secondary.ProfileID] != primary.ProfileID {
		t.Fatalf("link did not choose the primary profile: %+v", state)
	}
	if state.RecoveryReady[secondary.ProfileID] || state.KeyRecipients[recovery.ID].ProfileID != "" || !state.RetiredRecipientKeys[recovery.AgreementKey] ||
		!state.RetiredRecoverySigningKeys[recovery.SigningKey] || !state.validProfileBindings() {
		t.Fatal("secondary recovery survived linking")
	}
	if overwrite := state.Channels["room"].ACL.Profiles[secondary.ProfileID]; len(overwrite.Allow) != 0 ||
		!slices.Equal(overwrite.Deny, []string{"history.full"}) || len(state.Categories["category"].Profiles) != 0 || len(state.CategoryCreators) != 0 {
		t.Fatal("secondary profile grants could return after fresh admission")
	}
	if state.CheckGrant(state.Members[primary.ProfileID], state.scope(state.Channels["room"]), "message.send", 10) != MissingGrant {
		t.Fatal("primary gained the secondary's message grant")
	}
	unlink := ProfilePolicyUnlink{CutoverDigest: claim.CutoverDigest, ServerKey: claim.ServerKey, At: 11, ExpiresAt: 20, DeviceProof: claim.PrimaryProof}
	if err := state.applyProfileUnlink(primary, secondary.ProfileID, unlink); err != nil {
		t.Fatal(err)
	}
	if state.Members[secondary.ProfileID].Active || len(state.Members[secondary.ProfileID].Roles) != 0 ||
		state.KeyRecipients[secondary.DeviceID].ProfileID != "" || !state.PolicyDevices[secondary.DeviceID].Revoked ||
		state.PolicyDevices[secondary.DeviceID].ProfileID != secondary.ProfileID || !state.RetiredRecipientKeys[agreement] ||
		len(state.ProfileBindings) != 0 || len(state.ProfileDeviceOrigins) != 0 || !state.validProfileBindings() {
		t.Fatal("unlink restored a former membership or left credentials with primary authority")
	}
}

func TestProfileLinkKeepsOwnerPrimaryAndRejectsBansInLinkedOrigins(t *testing.T) {
	state, owner, primary, secondary := profileLinkFixture(t)
	if err := state.applyProfileLink(primary, profileLinkClaim(primary, owner)); !errors.Is(err, HierarchyDenied) {
		t.Fatalf("owner can become secondary: %v", err)
	}
	banned := MemberRemoval{Action: BanPolicyMember, ExpiresAt: 100}
	state.MemberRemovals[secondary.ProfileID] = banned
	var denied MemberBanError
	if err := state.applyProfileLink(primary, profileLinkClaim(primary, secondary)); !errors.As(err, &denied) {
		t.Fatalf("linked a banned secondary: %v", err)
	}
	delete(state.MemberRemovals, secondary.ProfileID)
	if err := state.applyProfileLink(primary, profileLinkClaim(primary, secondary)); err != nil {
		t.Fatal(err)
	}
	state.MemberRemovals[secondary.ProfileID] = banned
	if err := state.applyProfileLink(owner, profileLinkClaim(owner, primary)); !errors.As(err, &denied) {
		t.Fatalf("linked a group with a banned source: %v", err)
	}
	banned.Lifted = true
	state.MemberRemovals[secondary.ProfileID] = banned
	if err := state.applyProfileLink(owner, profileLinkClaim(owner, primary)); err != nil {
		t.Fatal(err)
	}
	if state.Owner != owner.ProfileID || state.ProfileBindings[secondary.ProfileID] != owner.ProfileID ||
		state.ProfileDeviceOrigins[secondary.DeviceID] != secondary.ProfileID || state.MemberRemovals[secondary.ProfileID] != banned ||
		state.PolicyDevices[secondary.DeviceID].ProfileID != owner.ProfileID || !state.validProfileBindings() {
		t.Fatal("nested link changed owner, discarded a ban record, or lost the device's source")
	}
	claim := profileLinkClaim(owner, primary)
	if err := state.applyProfileUnlink(owner, primary.ProfileID, ProfilePolicyUnlink{CutoverDigest: claim.CutoverDigest,
		ServerKey: claim.ServerKey, At: claim.At, ExpiresAt: claim.ExpiresAt, DeviceProof: claim.PrimaryProof}); err != nil {
		t.Fatal(err)
	}
	if state.PolicyDevices[secondary.DeviceID].Revoked || state.ProfileBindings[secondary.ProfileID] != owner.ProfileID ||
		!state.PolicyDevices[primary.DeviceID].Revoked || !state.validProfileBindings() {
		t.Fatal("unlink affected a different verified source")
	}
}

func TestCommitProfileLinkingBindsBothConsentsAndRotatesOnUnlink(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, ":memory:")
	now := time.UnixMilli(10)
	store := NewStoreWithClock(db, func() time.Time { return now })
	state, owner, primary, secondary := profileLinkFixture(t)
	state.PolicyAnchored = false
	state.Channels["open"] = Channel{Kind: "text", NextPosition: 2}
	state.Channels["hidden"] = Channel{Kind: "text", NextPosition: 2, ACL: ACL{Profiles: map[string]Overwrite{
		primary.ProfileID: {Deny: []string{ChannelView}}, secondary.ProfileID: {Deny: []string{ChannelView}},
	}}}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		digest := sha512.Sum512([]byte(draft.Action + draft.OperationID + draft.ResultDigest + draft.PreviousDigest))
		return digest[:], nil
	}
	verifyIntent := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		basis, err := ReadProfileLinkingBasis(ctx, query, actor, draft)
		if err != nil {
			return err
		}
		if basis.PrimaryDevice.PublicKey != state.PolicyDevices[primary.DeviceID].PublicKey {
			return ErrPolicySignatureRequired
		}
		if draft.Action == LinkPolicyProfiles && (basis.SecondaryDevice.PublicKey != state.PolicyDevices[secondary.DeviceID].PublicKey ||
			draft.ResourceChange.ProfileLink.SecondaryProof != profileLinkClaim(primary, secondary).SecondaryProof) {
			return ErrPolicySignatureRequired
		}
		return nil
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		expected, _ := sign(ctx, query, actor, draft)
		if !bytes.Equal(expected, draft.Signature) {
			return ErrPolicySignatureRequired
		}
		if isProfileLinkingAction(draft.Action) {
			return verifyIntent(ctx, query, actor, draft)
		}
		return nil
	}
	anchorDraft, err := store.PreviewPolicy(ctx, resolve(owner), PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	if err != nil {
		t.Fatal(err)
	}
	anchorDraft.Signature, _ = sign(ctx, db, owner, anchorDraft)
	anchor, err := store.CommitPolicy(ctx, resolve(owner), verify, anchorDraft)
	if err != nil {
		t.Fatal(err)
	}
	putEpochs := func() {
		t.Helper()
		current, _, err := store.Snapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		current.EpochWindows = map[string]EpochWindow{"open": {Current: 1}, "hidden": {Current: 1}}
		current.ArchiveHeads = map[string]uint64{"open": 1, "hidden": 1}
		raw, err := json.Marshal(current)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("UPDATE protected_policy SET snapshot=? WHERE id=1; DELETE FROM protected_rotation_tasks", raw); err != nil {
			t.Fatal(err)
		}
	}
	putEpochs()
	checkEpochs := func() {
		t.Helper()
		current, _, err := store.Snapshot(ctx)
		if err != nil || current.EpochWindows["open"].CurrentCutoff != now.UnixMilli()+graceMillis || current.EpochWindows["hidden"].CurrentCutoff != 0 {
			t.Fatalf("profile changes revoked wrong epoch windows: %+v, %v", current.EpochWindows, err)
		}
		var open, hidden int
		if err := db.QueryRow(`SELECT count(*) FILTER (WHERE channel_id='open'), count(*) FILTER (WHERE channel_id='hidden') FROM protected_rotation_tasks`).
			Scan(&open, &hidden); err != nil || open != 2 || hidden != 0 {
			t.Fatalf("rotation tasks open=%d hidden=%d: %v", open, hidden, err)
		}
	}
	claim := profileLinkClaim(primary, secondary)
	claim.At = 0
	intent := PolicyDraft{Action: LinkPolicyProfiles, OperationID: strings.Repeat("2", 32), PreviousDigest: anchor.Digest,
		ResourceChange: &PolicyResourceChange{ID: primary.ProfileID, ProfileLink: &claim}}
	syncFailure := errors.New("session synchronization failed")
	syncCalls := 0
	sync := func(context.Context, *sql.Tx, Principal, PolicyDraft) error {
		syncCalls++
		return nil
	}
	if _, err := store.CommitPolicy(ctx, resolve(primary), verify, intent); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic draft route accepted linking: %v", err)
	}
	bad := intent
	badClaim := claim
	badClaim.SecondaryProof = claim.PrimaryProof
	bad.ResourceChange = &PolicyResourceChange{ID: primary.ProfileID, ProfileLink: &badClaim}
	if _, err := store.CommitProfileLinking(ctx, resolve(primary), bad, verifyIntent, sign, verify, sync); !errors.Is(err, ErrPolicySignatureRequired) {
		t.Fatalf("unsigned secondary consent accepted: %v", err)
	}
	if _, err := store.CommitProfileLinking(ctx, resolve(primary), intent, verifyIntent, sign, verify,
		func(context.Context, *sql.Tx, Principal, PolicyDraft) error { return syncFailure }); !errors.Is(err, syncFailure) {
		t.Fatalf("failed runtime synchronization accepted: %v", err)
	}
	if current, revision, err := store.Snapshot(ctx); err != nil || revision != 1 || len(current.ProfileBindings) != 0 {
		t.Fatalf("failed linking survived rollback: revision=%d, err=%v", revision, err)
	}
	linked, err := store.CommitProfileLinking(ctx, resolve(primary), intent, verifyIntent, sign, verify, sync)
	if err != nil || linked.Draft.Revision != 2 || linked.Draft.ResourceChange.ProfileLink.At != now.UnixMilli() {
		t.Fatalf("commit link: %+v, %v", linked, err)
	}
	checkEpochs()
	now = time.UnixMilli(21)
	if retry, err := store.CommitProfileLinking(ctx, resolve(primary), intent, verifyIntent, sign, verify, sync); err != nil || retry.Digest != linked.Digest || syncCalls != 1 {
		t.Fatalf("exact retry after expiration: %s, %v", retry.Digest, err)
	}
	putEpochs()
	unlink := PolicyDraft{Action: UnlinkPolicyProfile, OperationID: strings.Repeat("3", 32), PreviousDigest: anchor.Digest,
		ResourceChange: &PolicyResourceChange{ID: secondary.ProfileID, ProfileUnlink: &ProfilePolicyUnlink{
			CutoverDigest: claim.CutoverDigest, ServerKey: claim.ServerKey, ExpiresAt: 30, DeviceProof: claim.PrimaryProof}}}
	if _, err := store.CommitProfileLinking(ctx, resolve(primary), unlink, verifyIntent, sign, verify, sync); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("stale head accepted: %v", err)
	}
	unlink.PreviousDigest = linked.Digest
	unlinked, err := store.CommitProfileLinking(ctx, resolve(primary), unlink, verifyIntent, sign, verify, sync)
	if err != nil || unlinked.Draft.Revision != 3 || syncCalls != 2 {
		t.Fatalf("commit unlink: %+v, %v", unlinked, err)
	}
	checkEpochs()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := VerifyActivatedPolicyChain(ctx, tx, anchor.Digest, owner, verify); err != nil {
		t.Fatalf("profile link snapshots do not replay: %v", err)
	}
}
