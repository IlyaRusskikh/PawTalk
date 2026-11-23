package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRecoveryConfirmationCurrentCoverageCAS(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	now := time.UnixMilli(90_000)
	store := NewStoreWithClock(db, func() time.Time { return now })
	ownerID, readerID := strings.Repeat("a", 64), strings.Repeat("b", 64)
	recoveryID := strings.Repeat("c", 64)
	channel, serverID := strings.Repeat("d", 32), strings.Repeat("e", 32)
	owner, reader := Principal{ProfileID: ownerID}, Principal{ProfileID: readerID}
	initial := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: ownerID, Roles: map[string]Role{Everyone: {Grants: []string{ChannelView, "history.full"}}}},
			Members: map[string]Subject{
				ownerID: {ID: ownerID, Active: true}, readerID: {ID: readerID, Active: true},
			},
		},
		Channels:      map[string]Channel{channel: {Kind: "text", NextPosition: 5}},
		PolicyDevices: make(map[string]PolicyDevice, 2),
		KeyRecipients: make(map[string]KeyRecipient, 3),
	}
	for i, actor := range []*Principal{&owner, &reader} {
		key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{byte(i + 1)}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
		actor.DeviceID = hexHash(key)
		initial.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: actor.ProfileID, PublicKey: hex.EncodeToString(key)}
		initial.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, byte(i+30))}
	}
	recoverySigner := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, ed25519.SeedSize))
	identity := RecoveryIdentity{ID: recoveryID, SigningKey: hex.EncodeToString(recoverySigner.Public().(ed25519.PublicKey)), AgreementKey: recoveryTestAgreementKey(t, 32)}
	initial.RecoveryIdentities = map[string]RecoveryIdentity{readerID: identity}
	initial.KeyRecipients[recoveryID] = KeyRecipient{ProfileID: readerID, Kind: "recovery", PublicKey: identity.AgreementKey}
	if _, err := db.Exec("CREATE TABLE server_state(id INTEGER PRIMARY KEY, server_id TEXT); INSERT INTO server_state VALUES(1,?)", serverID); err != nil {
		t.Fatal(err)
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	resolveOwner, resolveReader := resolve(owner), resolve(reader)
	sign := func(_ context.Context, _ SessionQuery, _ Principal, draft PolicyDraft) ([]byte, error) {
		result := sha512.Sum512([]byte(draft.OperationID + draft.ResultDigest))
		return result[:], nil
	}
	verify := func(ctx context.Context, query SessionQuery, actor Principal, draft PolicyDraft) error {
		expected, _ := sign(ctx, query, actor, draft)
		if !bytes.Equal(draft.Signature, expected) {
			return ErrPolicySignatureRequired
		}
		return nil
	}
	preview, err := store.PreviewPolicyForTransport(ctx, resolveOwner, PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	if err != nil {
		t.Fatal(err)
	}
	preview.Draft.Signature, _ = sign(ctx, db, owner, preview.Draft)
	anchor, err := store.CommitPolicy(ctx, resolveOwner, verify, preview.Draft)
	if err != nil {
		t.Fatal(err)
	}
	type opened struct {
		record EpochRecord
		packet []byte
		key    ed25519.PrivateKey
	}
	verifyEpoch := func(_ context.Context, _ SessionQuery, actor Principal, record EpochRecord) error {
		if actor != owner || !isDigest(record.PackagesDigest) || record.Signature[0] != 0x73 {
			return ErrPolicySignatureRequired
		}
		return nil
	}
	rotate := func(purpose string, seed byte) opened {
		t.Helper()
		task, err := store.ClaimRotation(ctx, resolveOwner, channel, purpose)
		if err != nil {
			t.Fatal(err)
		}
		key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{seed}, ed25519.SeedSize))
		packet := append(make([]byte, RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize), key.Public().(ed25519.PublicKey)...)
		var packages []EpochPackage
		for id := range task.Recipients {
			data := make([]byte, EpochPackageSize)
			if id == recoveryID {
				data = packet
			}
			packages = append(packages, EpochPackage{RecipientID: id, Purpose: purpose, Ciphertext: data})
		}
		record := task.EpochRecord
		record.KeyID, record.Signature = hexHash([]byte{seed}), bytes.Repeat([]byte{0x73}, ed25519.SignatureSize)
		record.Signature[1] = seed
		record.PackagesDigest, err = PackagesDigest(packages)
		if err != nil {
			t.Fatal(err)
		}
		links := make([]ArchiveLink, len(task.ArchiveTargets))
		for i, target := range task.ArchiveTargets {
			links[i] = ArchiveLink{ArchiveTarget: target, Ciphertext: make([]byte, ArchiveLinkSize)}
		}
		if purpose == ArchiveEpoch {
			record.ArchiveLinksDigest, err = ArchiveLinksDigest(links)
			if err != nil {
				t.Fatal(err)
			}
		}
		if err := store.CommitEpoch(ctx, resolveOwner, verifyEpoch, record, packages, links); err != nil {
			t.Fatal(err)
		}
		return opened{record: record, packet: packet, key: key}
	}
	firstLive := rotate(LiveEpoch, 10)
	archive := rotate(ArchiveEpoch, 11)
	makeIntent := func(operation string, packages ...opened) PolicyDraft {
		t.Helper()
		confirmation := &RecoveryPolicyConfirmation{RecoveryID: recoveryID, CutoverDigest: strings.Repeat("f", 64),
			ServerKey: recoveryTestProof(32, 1), Nonce: hexHash([]byte(operation)), ExpiresAt: now.Add(time.Second).UnixMilli(),
			Items: make([]RecoveryReadyItem, 0, len(packages)), RecoveryProof: recoveryTestProof(64, 2), DeviceProof: recoveryTestProof(64, 3)}
		for _, opened := range packages {
			item := RecoveryReadyItem{ChannelID: channel, Purpose: opened.record.Purpose, Generation: opened.record.Generation,
				EpochDigest: hexHash(opened.record.Signature), PackageDigest: hexHash(opened.packet),
				OpeningKey: hex.EncodeToString(opened.key.Public().(ed25519.PublicKey))}
			frame, err := SignatureFrame("pawtalk-protected-recovery-package-open-v1", serverID, confirmation.CutoverDigest,
				readerID, reader.DeviceID, recoveryID, anchor.Digest, channel, item.Purpose, strconv.FormatUint(item.Generation, 10),
				item.EpochDigest, item.PackageDigest, confirmation.Nonce, strconv.FormatInt(confirmation.ExpiresAt, 10))
			if err != nil {
				t.Fatal(err)
			}
			item.OpeningProof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(opened.key, frame))
			item.RecoveryProof = base64.RawURLEncoding.EncodeToString(ed25519.Sign(recoverySigner, frame))
			confirmation.Items = append(confirmation.Items, item)
		}
		return PolicyDraft{Action: ConfirmPolicyRecovery, OperationID: operation, PreviousDigest: anchor.Digest,
			ResourceChange: &PolicyResourceChange{ID: readerID, RecoveryConfirmation: confirmation}}
	}
	verifyIntent := func(context.Context, SessionQuery, Principal, PolicyDraft) error { return nil }
	confirm := func(intent PolicyDraft) (PolicyProof, error) {
		t.Helper()
		return store.CommitRecoveryConfirmation(ctx, resolveReader, intent, verifyIntent, sign, verify, verifyEpoch)
	}
	unchanged := func() {
		t.Helper()
		state, revision, err := readState(db.QueryRow("SELECT revision,snapshot FROM protected_policy WHERE id=1"))
		if err != nil || revision != 1 || state.RecoveryReady[readerID] {
			t.Fatalf("unsuccessful confirmation changed policy: %d, %v", revision, err)
		}
		var entries int
		if err := db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE action='recovery.confirm'").Scan(&entries); err != nil || entries != 0 {
			t.Fatalf("unsuccessful confirmation wrote an audit entry: %d, %v", entries, err)
		}
	}
	first := makeIntent(strings.Repeat("2", 32), archive, firstLive)
	if _, err := store.PreviewPolicy(ctx, resolveReader, first); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic preview accepted readiness confirmation: %v", err)
	}
	if _, err := store.CommitPolicy(ctx, resolveReader, verify, first); !errors.Is(err, InvalidAction) {
		t.Fatalf("generic commit accepted readiness confirmation: %v", err)
	}
	for _, malformed := range []PolicyDraft{
		makeIntent(strings.Repeat("3", 32), firstLive),
		makeIntent(strings.Repeat("4", 32), firstLive, archive),
		makeIntent(strings.Repeat("5", 32), archive, archive),
	} {
		if _, err := confirm(malformed); !errors.Is(err, ErrRecoveryCoverageChanged) {
			t.Fatalf("inexact coverage was accepted: %v", err)
		}
	}
	bad := makeIntent(strings.Repeat("6", 32), archive, firstLive)
	bad.ResourceChange.RecoveryConfirmation.Items[0].OpeningProof = recoveryTestProof(64, 5)
	if _, err := confirm(bad); !errors.Is(err, ErrInvalidRecoveryOpeningProof) {
		t.Fatalf("invalid opening proof was accepted: %v", err)
	}
	bad = makeIntent(strings.Repeat("6", 32), archive, firstLive)
	bad.ResourceChange.RecoveryConfirmation.Items[0].RecoveryProof = recoveryTestProof(64, 5)
	if _, err := confirm(bad); !errors.Is(err, ErrInvalidRecoveryOpeningProof) {
		t.Fatalf("invalid recovery signature on an opening proof was accepted: %v", err)
	}
	unchanged()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := enqueueRotation(ctx, tx, channel, LiveEpoch, 1, "", now.UnixMilli()); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	secondLive := rotate(LiveEpoch, 12)
	if _, err := confirm(first); !errors.Is(err, ErrRecoveryCoverageChanged) {
		t.Fatalf("rotation did not invalidate the old package witnesses: %v", err)
	}
	unchanged()
	fresh := makeIntent(strings.Repeat("7", 32), archive, secondLive)
	pending := func() string {
		t.Helper()
		var taskID string
		if err := db.QueryRow("SELECT task_id FROM protected_rotation_tasks WHERE channel_id=? AND purpose='archive'", channel).Scan(&taskID); err != nil {
			t.Fatal(err)
		}
		return taskID
	}
	pendingArchive := pending()
	ready, err := confirm(fresh)
	if err != nil || ready.Draft.Revision != 2 {
		t.Fatalf("current recovery opening proofs were rejected: %+v, %v", ready, err)
	}
	applied, _, err := readState(db.QueryRow("SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil || !applied.RecoveryReady[readerID] || applied.RecoveryIdentities[readerID] != identity ||
		applied.EpochWindows[channel].Current != 2 || applied.ArchiveHeads[channel] != 1 || pending() != pendingArchive {
		t.Fatalf("confirmed transfer changed authorization or the epoch queue: %v", err)
	}
	var liveTasks, entries int
	if err := db.QueryRow("SELECT COUNT(*) FROM protected_rotation_tasks WHERE purpose='live'").Scan(&liveTasks); err != nil || liveTasks != 0 {
		t.Fatalf("readiness confirmation enqueued a live rotation: %d, %v", liveTasks, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM protected_audit_events WHERE action='recovery.confirm' AND actor=? AND object_id=?",
		readerID, readerID).Scan(&entries); err != nil || entries != 1 {
		t.Fatalf("readiness confirmation audit entry: %d, %v", entries, err)
	}
	now = now.Add(2 * time.Second)
	if retry, err := confirm(fresh); err != nil || retry.Digest != ready.Digest {
		t.Fatalf("exact retry after deadline did not return the signed receipt: %v", err)
	}
	if recovered, err := ReadRecoveryConfirmationIdentity(ctx, db, reader, ready.Draft); err != nil || recovered != identity {
		t.Fatalf("could not reproduce the identity from the predecessor proof: %v", err)
	}
	if err := VerifyHistoricalRecoveryConfirmationEvidence(ctx, db, reader, ready.Draft, serverID, verifyEpoch); err != nil {
		t.Fatalf("historical witnesses failed after challenge expiration: %v", err)
	}
}

func TestRecoveryConfirmationWithNoApplicableChannels(t *testing.T) {
	profileID, deviceID, recoveryID := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64)
	actor := Principal{ProfileID: profileID, DeviceID: deviceID}
	identity := RecoveryIdentity{ID: recoveryID, SigningKey: strings.Repeat("4", 64), AgreementKey: recoveryTestAgreementKey(t, 50)}
	state := State{
		RoleSnapshot:       RoleSnapshot{Members: map[string]Subject{profileID: {ID: profileID, Active: true}}},
		PolicyAnchored:     true,
		PolicyDevices:      map[string]PolicyDevice{deviceID: {ProfileID: profileID}},
		RecoveryIdentities: map[string]RecoveryIdentity{profileID: identity},
		KeyRecipients:      map[string]KeyRecipient{recoveryID: {ProfileID: profileID, Kind: "recovery", PublicKey: identity.AgreementKey}},
	}
	confirmation := &RecoveryPolicyConfirmation{RecoveryID: recoveryID, CutoverDigest: strings.Repeat("5", 64),
		ServerKey: recoveryTestProof(32, 1), Nonce: strings.Repeat("6", 64), ExpiresAt: 1,
		RecoveryProof: recoveryTestProof(64, 2), DeviceProof: recoveryTestProof(64, 3)}
	change := PolicyResourceChange{ID: profileID, RecoveryConfirmation: confirmation}
	if err := state.applyRecoveryConfirmation(actor, change); !errors.Is(err, InvalidAction) || state.RecoveryReady[profileID] {
		t.Fatalf("absent coverage was accepted: %v", err)
	}
	confirmation.Items = []RecoveryReadyItem{}
	if err := state.applyRecoveryConfirmation(actor, change); err != nil || !state.RecoveryReady[profileID] {
		t.Fatalf("explicit empty coverage could not confirm an unscoped member: %v", err)
	}
}
