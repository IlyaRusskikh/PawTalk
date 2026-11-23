package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRecoveryCoverageAndScopedPackageDelivery(t *testing.T) {
	const (
		public  = "11111111111111111111111111111111"
		limited = "22222222222222222222222222222222"
		hidden  = "33333333333333333333333333333333"
		empty   = "44444444444444444444444444444444"
		voice   = "55555555555555555555555555555555"
	)
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "recovery.sqlite")))
	now := time.UnixMilli(10_000)
	store := NewStoreWithClock(db, func() time.Time { return now })
	owner, reader := Principal{ProfileID: strings.Repeat("a", 64)}, Principal{ProfileID: strings.Repeat("b", 64)}
	recoverySigner := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{19}, ed25519.SeedSize))
	recovery := RecoveryIdentity{ID: strings.Repeat("c", 64), SigningKey: hex.EncodeToString(recoverySigner.Public().(ed25519.PublicKey)), AgreementKey: recoveryTestAgreementKey(t, 3)}
	initial := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: owner.ProfileID, Order: []string{"reader"}, Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView}},
				"reader": {Grants: []string{"history.full"}},
			}},
			Members: map[string]Subject{
				owner.ProfileID:  {ID: owner.ProfileID, Active: true},
				reader.ProfileID: {ID: reader.ProfileID, Active: true, Roles: []string{"reader"}},
			},
		},
		Channels: map[string]Channel{
			public:  {Kind: "text", NextPosition: 4},
			limited: {Kind: "text", NextPosition: 7, ACL: ACL{Profiles: map[string]Overwrite{reader.ProfileID: {Deny: []string{"history.full"}}}}},
			hidden:  {Kind: "text", NextPosition: 4, ACL: ACL{Profiles: map[string]Overwrite{reader.ProfileID: {Deny: []string{ChannelView}}}}},
			empty:   {Kind: "text", NextPosition: 1},
			voice:   {Kind: "voice", NextPosition: 1},
		},
		PolicyDevices:      make(map[string]PolicyDevice),
		KeyRecipients:      map[string]KeyRecipient{recovery.ID: {ProfileID: reader.ProfileID, Kind: "recovery", PublicKey: recovery.AgreementKey}},
		RecoveryIdentities: map[string]RecoveryIdentity{reader.ProfileID: recovery},
	}
	ownerKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, 32))
	for i, actor := range []*Principal{&owner, &reader} {
		device := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{byte(i + 1)}, 32))
		publicKey := device.Public().(ed25519.PublicKey)
		actor.DeviceID = hexHash(publicKey)
		initial.PolicyDevices[actor.DeviceID] = PolicyDevice{ProfileID: actor.ProfileID, PublicKey: hex.EncodeToString(publicKey)}
		initial.KeyRecipients[actor.DeviceID] = KeyRecipient{ProfileID: actor.ProfileID, Kind: "device", PublicKey: recoveryTestAgreementKey(t, byte(i+1))}
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(actor Principal) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actor, nil }
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	commit := func(input PolicyDraft) PolicyProof {
		t.Helper()
		preview, err := store.PreviewPolicyForTransport(ctx, resolve(owner), input)
		if err != nil {
			t.Fatal(err)
		}
		draft := preview.Draft
		draft.Signature = ed25519.Sign(ownerKey, []byte(draft.OperationID+draft.ResultDigest))
		verify := func(_ context.Context, _ SessionQuery, actor Principal, signed PolicyDraft) error {
			if actor != owner || !ed25519.Verify(ownerKey.Public().(ed25519.PublicKey), []byte(signed.OperationID+signed.ResultDigest), signed.Signature) {
				return ErrPolicySignatureRequired
			}
			return nil
		}
		proof, err := store.CommitPolicy(ctx, resolve(owner), verify, draft)
		if err != nil {
			t.Fatal(err)
		}
		return proof
	}
	anchor := commit(PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("a", 32)})
	sigFrame := func(record EpochRecord) []byte {
		frame, err := SignatureFrame(record.ChannelID, record.Purpose, strconv.FormatUint(record.Generation, 10),
			record.KeyID, record.PreviousDigest, record.PackagesDigest, record.PolicyDigest)
		if err != nil {
			t.Fatal(err)
		}
		return frame
	}
	openingPrivate := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{8}, 32))
	opening := openingPrivate.Public().(ed25519.PublicKey)
	newPacket := bytes.Repeat([]byte{9}, RecoveryEpochPackageSize)
	copy(newPacket[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:], opening)
	seedEpoch := func(channel, purpose, symbol string, generation uint64, ciphertext []byte) string {
		t.Helper()
		packages := []EpochPackage{
			{RecipientID: recovery.ID, Purpose: purpose, Ciphertext: ciphertext},
			{RecipientID: owner.DeviceID, Purpose: purpose, Ciphertext: make([]byte, EpochPackageSize)},
		}
		if channel == public && purpose == LiveEpoch && generation == 2 {
			packages = append(packages, EpochPackage{RecipientID: reader.DeviceID, Purpose: purpose, Ciphertext: make([]byte, EpochPackageSize)})
		}
		digest, err := PackagesDigest(packages)
		if err != nil {
			t.Fatal(err)
		}
		record := EpochRecord{ChannelID: channel, Purpose: purpose, Generation: generation, Revision: anchor.Draft.Revision,
			PolicyDigest: anchor.Draft.ResultDigest, KeyID: strings.Repeat(symbol, 64), TaskID: strings.Repeat(symbol, 32), PackagesDigest: digest}
		if purpose == ArchiveEpoch {
			record.ArchiveThrough = 1
		}
		if generation > 1 {
			if err := db.QueryRow("SELECT digest FROM protected_epochs WHERE channel_id=? AND purpose=? AND generation=?",
				channel, purpose, generation-1).Scan(&record.PreviousDigest); err != nil {
				t.Fatal(err)
			}
		}
		record.Signature = ed25519.Sign(ownerKey, sigFrame(record))
		epoch := EpochProof{Principal: owner, Record: record}
		raw, err := json.Marshal(epoch)
		if err != nil {
			t.Fatal(err)
		}
		signatureHash := hexHash(record.Signature)
		exec("INSERT INTO protected_epochs VALUES(?,?,?,?,?,?,?)", channel, purpose, generation, record.KeyID, record.TaskID, signatureHash, raw)
		for _, pkg := range packages {
			exec(`INSERT INTO protected_epoch_packages(channel_id,generation,recipient_id,recipient_key,purpose,ciphertext)
			VALUES(?,?,?,?,?,?)`, channel, generation, pkg.RecipientID, initial.KeyRecipients[pkg.RecipientID].PublicKey, purpose, pkg.Ciphertext)
		}
		return signatureHash
	}
	publicDigest := seedEpoch(public, LiveEpoch, "1", 1, newPacket)
	seedEpoch(public, ArchiveEpoch, "2", 1, make([]byte, EpochPackageSize))
	seedEpoch(limited, LiveEpoch, "3", 1, newPacket)
	seedEpoch(hidden, LiveEpoch, "4", 1, newPacket)
	initial.Roles["unused"] = Role{}
	head := commit(PolicyDraft{Action: UpdatePolicyRoles, OperationID: strings.Repeat("b", 32),
		RoleUpdate: &RolePolicyUpdate{Roles: initial.Roles, Order: []string{"reader", "unused"}}})
	applied, _, err := readState(db.QueryRow("SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		t.Fatal(err)
	}
	applied.EpochWindows = map[string]EpochWindow{public: {Current: 1}, limited: {Current: 1}, hidden: {Current: 1}}
	applied.ArchiveHeads = map[string]uint64{public: 1}
	save := func(state State) {
		t.Helper()
		raw, err := json.Marshal(state)
		if err != nil {
			t.Fatal(err)
		}
		exec("UPDATE protected_policy SET snapshot=? WHERE id=1", raw)
	}
	save(applied)
	coverage := func(actor Principal) RecoveryCoverage {
		t.Helper()
		var result RecoveryCoverage
		err := store.DispatchRecoveryCoverage(ctx, resolve(actor), func(value RecoveryCoverage) error { result = value; return nil })
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	result := coverage(reader)
	if result.RecoveryID != recovery.ID || result.PolicyHead != head.Digest || len(result.Items) != 5 {
		t.Fatalf("unexpected recovery coverage: %+v", result)
	}
	if want := (RecoveryCoverageItem{ChannelID: public, Purpose: LiveEpoch, Generation: 1, EpochDigest: publicDigest, PackageDigest: hexHash(newPacket)}); result.Items[0] != want {
		t.Fatalf("current live packet missing from coverage: %+v", result.Items[0])
	}
	if want := (RecoveryCoverageItem{ChannelID: public, Purpose: ArchiveEpoch, Generation: 1, Pending: true}); result.Items[1] != want {
		t.Fatalf("legacy package was treated as a recoverable archive: %+v", result.Items[1])
	}
	if result.Items[2].ChannelID != limited || result.Items[2].Purpose != LiveEpoch || result.Items[2].Pending ||
		result.Items[3].ChannelID != empty || !result.Items[3].Pending || result.Items[3].Generation != 0 ||
		result.Items[4].ChannelID != empty || !result.Items[4].Pending || result.Items[4].Generation != 0 {
		t.Fatalf("limited or absent generations were misclassified: %+v", result.Items)
	}

	verifyEpoch := func(_ context.Context, _ SessionQuery, actor Principal, record EpochRecord) error {
		if actor != owner || !ed25519.Verify(ownerKey.Public().(ed25519.PublicKey), sigFrame(record), record.Signature) {
			return ErrEpochConflict
		}
		return nil
	}
	cache := &TextChannelPolicyProofCache{}
	read := func(actor Principal, channel, purpose string, accept func(EpochPackageDelivery) error) error {
		return store.DispatchRecoveryPackage(ctx, resolve(actor), channel, purpose, verifyEpoch, cache, true, accept)
	}
	deny := func(EpochPackageDelivery) error {
		t.Fatal("unavailable or out-of-scope recovery package was delivered")
		return nil
	}
	for _, check := range []struct {
		actor            Principal
		channel, purpose string
		err              error
	}{
		{reader, public, ArchiveEpoch, ErrEpochRecipients},
		{reader, limited, ArchiveEpoch, ChannelRestricted},
		{reader, hidden, LiveEpoch, ChannelRestricted},
		{Principal{ProfileID: reader.ProfileID, DeviceID: owner.DeviceID}, public, LiveEpoch, Inactive},
		{owner, public, LiveEpoch, ErrEpochRecipients},
	} {
		if err := read(check.actor, check.channel, check.purpose, deny); !errors.Is(err, check.err) {
			t.Fatalf("package restriction for %s/%s: %v", check.channel, check.purpose, err)
		}
	}
	if err := read(reader, limited, LiveEpoch, func(delivery EpochPackageDelivery) error {
		if delivery.Package.RecipientID != recovery.ID || !bytes.Equal(delivery.Package.Ciphertext, newPacket) || delivery.Proof.Count != 2 ||
			delivery.TextPolicy == nil || delivery.TextPolicy.Recipient == nil || delivery.TextPolicy.Revision != head.Draft.Revision ||
			delivery.TextPolicy.Recipient.Statement.Kind != "recovery" || delivery.TextPolicy.Recipient.Statement.RecipientID != recovery.ID ||
			delivery.AdmissionPolicy == nil || delivery.AdmissionPolicy.Recipient == nil || delivery.AdmissionPolicy.Revision != anchor.Draft.Revision ||
			delivery.AdmissionPolicy.Recipient.Statement.RecipientID != recovery.ID ||
			delivery.TextPolicy.Recipient.Statement.FirstPosition != delivery.AdmissionPolicy.Recipient.Statement.FirstPosition ||
			delivery.Epoch.SigningPolicy == nil || delivery.Epoch.SigningPolicy.Recipient == nil ||
			delivery.Epoch.SigningPolicy.Recipient.Statement.RecipientID != owner.DeviceID {
			t.Fatalf("scoped recovery package or its proof is incomplete: %+v", delivery)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	priorAdmission := applied.Admissions[limited][reader.ProfileID]
	applied.Admissions[limited][reader.ProfileID] = Admission{FirstPosition: priorAdmission.FirstPosition + 1}
	item := RecoveryCoverageItem{ChannelID: limited, Purpose: LiveEpoch, Generation: 1}
	candidate, err := readRecoveryEpochCandidate(ctx, db, applied, reader.ProfileID, recovery, item, now.UnixMilli(), &recoveryEpochBasis{})
	applied.Admissions[limited][reader.ProfileID] = priorAdmission
	if err != nil || candidate.packageDigest != "" {
		t.Fatalf("live recovery packet crossed an admission boundary: %+v, %v", candidate, err)
	}

	archiveDigest := seedEpoch(empty, ArchiveEpoch, "5", 1, newPacket)
	applied.ArchiveHeads[empty] = 1
	save(applied)
	if want := (RecoveryCoverageItem{ChannelID: empty, Purpose: ArchiveEpoch, Generation: 1, EpochDigest: archiveDigest, PackageDigest: hexHash(newPacket)}); coverage(reader).Items[4] != want {
		t.Fatal("eligible current archive was not covered")
	}
	if err := read(reader, empty, ArchiveEpoch, func(delivery EpochPackageDelivery) error {
		if delivery.Package.RecipientID != recovery.ID || delivery.Package.Purpose != ArchiveEpoch ||
			!bytes.Equal(delivery.Package.Ciphertext, newPacket) || delivery.AdmissionPolicy != nil {
			t.Fatalf("incorrect recovery archive delivery: %+v", delivery)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	openingKeys := map[[2]string]ed25519.PrivateKey{{empty, ArchiveEpoch}: openingPrivate}
	fresh := func(channel, purpose, id string, generation uint64) {
		t.Helper()
		key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{id[0]}, 32))
		openingKeys[[2]string{channel, purpose}] = key
		packet := bytes.Repeat([]byte{9}, RecoveryEpochPackageSize)
		copy(packet[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:], key.Public().(ed25519.PublicKey))
		seedEpoch(channel, purpose, id, generation, packet)
	}
	fresh(public, LiveEpoch, "6", 2)
	fresh(public, ArchiveEpoch, "7", 2)
	fresh(limited, LiveEpoch, "8", 2)
	fresh(empty, LiveEpoch, "9", 1)
	applied.EpochWindows[public], applied.EpochWindows[limited], applied.EpochWindows[empty] =
		EpochWindow{Current: 2}, EpochWindow{Current: 2}, EpochWindow{Current: 1}
	applied.ArchiveHeads[public] = 2
	save(applied)
	serverID := strings.Repeat("a", 32)
	signed := RecoveryPolicyConfirmation{RecoveryID: recovery.ID, CutoverDigest: strings.Repeat("c", 64),
		Nonce: strings.Repeat("e", 64), ExpiresAt: now.Add(time.Second).UnixMilli(), Items: []RecoveryReadyItem{}}
	opened := func(item RecoveryCoverageItem, key ed25519.PrivateKey) RecoveryReadyItem {
		t.Helper()
		frame, err := SignatureFrame("pawtalk-protected-recovery-package-open-v1", serverID, signed.CutoverDigest,
			reader.ProfileID, reader.DeviceID, recovery.ID, head.Digest, item.ChannelID, item.Purpose,
			strconv.FormatUint(item.Generation, 10), item.EpochDigest, item.PackageDigest, signed.Nonce, strconv.FormatInt(signed.ExpiresAt, 10))
		if err != nil {
			t.Fatal(err)
		}
		return RecoveryReadyItem{ChannelID: item.ChannelID, Purpose: item.Purpose, Generation: item.Generation,
			EpochDigest: item.EpochDigest, PackageDigest: item.PackageDigest, OpeningKey: hex.EncodeToString(key.Public().(ed25519.PublicKey)),
			OpeningProof:  base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, frame)),
			RecoveryProof: base64.RawURLEncoding.EncodeToString(ed25519.Sign(recoverySigner, frame))}
	}
	for _, item := range coverage(reader).Items {
		if item.Pending {
			t.Fatalf("fixture cannot prove coverage for a pending item: %+v", item)
		}
		signed.Items = append(signed.Items, opened(item, openingKeys[[2]string{item.ChannelID, item.Purpose}]))
	}
	slices.SortFunc(signed.Items, func(a, b RecoveryReadyItem) int {
		if byChannel := strings.Compare(a.ChannelID, b.ChannelID); byChannel != 0 {
			return byChannel
		}
		return strings.Compare(a.Purpose, b.Purpose)
	})
	confirm := func(state State, evidence RecoveryPolicyConfirmation, at int64, current bool) error {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		return VerifyRecoveryConfirmationEvidence(ctx, tx, state, reader, head, serverID, evidence, verifyEpoch, at, current)
	}
	if err := confirm(applied, signed, now.UnixMilli(), true); err != nil {
		t.Fatalf("complete verified recovery evidence: %v", err)
	}
	previous := applied
	previous.PolicyAnchored, previous.EpochWindows, previous.ArchiveHeads = false, nil, nil
	if err := confirm(previous, signed, signed.ExpiresAt+1, false); err != nil {
		t.Fatalf("historical confirmation required current epochs or a fresh deadline: %v", err)
	}
	if err := confirm(applied, signed, signed.ExpiresAt, true); !errors.Is(err, ErrRecoveryChallengeExpired) {
		t.Fatalf("expired current confirmation: %v", err)
	}
	advanced := applied
	advanced.EpochWindows = maps.Clone(applied.EpochWindows)
	advanced.EpochWindows[limited] = EpochWindow{Current: 3}
	if err := confirm(advanced, signed, now.UnixMilli(), true); !errors.Is(err, ErrRecoveryCoverageChanged) {
		t.Fatalf("confirmation after a concurrent rotation: %v", err)
	}
	for _, check := range []struct {
		name   string
		change func(*RecoveryPolicyConfirmation)
		err    error
	}{
		{"missing scope", func(c *RecoveryPolicyConfirmation) { c.Items = c.Items[1:] }, ErrRecoveryCoverageChanged},
		{"duplicate scope", func(c *RecoveryPolicyConfirmation) { c.Items[0] = c.Items[1] }, ErrRecoveryCoverageChanged},
		{"hidden scope", func(c *RecoveryPolicyConfirmation) { c.Items[0].ChannelID = hidden }, ErrRecoveryCoverageChanged},
		{"wrong package digest", func(c *RecoveryPolicyConfirmation) { c.Items[0].PackageDigest = strings.Repeat("a", 64) }, ErrRecoveryCoverageChanged},
		{"wrong opening key", func(c *RecoveryPolicyConfirmation) { c.Items[0].OpeningKey = strings.Repeat("a", 64) }, ErrRecoveryCoverageChanged},
		{"different nonce", func(c *RecoveryPolicyConfirmation) { c.Nonce = strings.Repeat("f", 64) }, ErrInvalidRecoveryOpeningProof},
	} {
		t.Run(check.name, func(t *testing.T) {
			attempt := signed
			attempt.Items = slices.Clone(attempt.Items)
			check.change(&attempt)
			if err := confirm(applied, attempt, now.UnixMilli(), true); !errors.Is(err, check.err) {
				t.Fatalf("invalid confirmation: %v", err)
			}
		})
	}

	reusedKey := openingKeys[[2]string{public, ArchiveEpoch}]
	reusedCiphertext := bytes.Repeat([]byte{42}, RecoveryEpochPackageSize)
	copy(reusedCiphertext[RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize:], reusedKey.Public().(ed25519.PublicKey))
	reusedDigest := seedEpoch(public, LiveEpoch, "a", 3, reusedCiphertext)
	advanced.EpochWindows[limited] = applied.EpochWindows[limited]
	advanced.EpochWindows[public] = EpochWindow{Current: 3}
	replayed := signed
	replayed.Items = slices.Clone(signed.Items)
	replayed.Items[1] = opened(RecoveryCoverageItem{ChannelID: public, Purpose: LiveEpoch, Generation: 3,
		EpochDigest: reusedDigest, PackageDigest: hexHash(reusedCiphertext)}, reusedKey)
	if err := confirm(advanced, replayed, now.UnixMilli(), true); !errors.Is(err, ErrRecoveryCoverageChanged) {
		t.Fatalf("two signed packets shared one proof-of-possession key: %v", err)
	}

	t.Run("explicit archival lease recovery", func(t *testing.T) {
		exec("DELETE FROM protected_rotation_tasks")
		exec(`INSERT INTO protected_rotation_tasks(task_id,channel_id,purpose,revision,initiator,priority_until)
			VALUES(?,?,'archive',?,?,?)`, strings.Repeat("f", 32), public, head.Draft.Revision, reader.ProfileID, now.UnixMilli())
		expectTask := []PendingRotation{{ChannelID: public, Purpose: ArchiveEpoch}}
		if err := store.DispatchPendingRotations(ctx, resolve(reader), func(tasks []PendingRotation) error {
			if len(tasks) != 0 {
				t.Fatalf("normal scan used unrequested recovery material: %+v", tasks)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if err := store.DispatchPendingRecoveryRotations(ctx, resolve(reader), func(tasks []PendingRotation) error {
			if !slices.Equal(tasks, expectTask) {
				t.Fatalf("recovered device could not see the archive task: %+v", tasks)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ClaimRotation(ctx, resolve(reader), public, ArchiveEpoch); !errors.Is(err, ErrRotationUnavailable) {
			t.Fatalf("device-only claim used recovery packets: %v", err)
		}
		var task RotationTask
		if err := store.DispatchRecoveryRotationTask(ctx, resolve(reader), public, ArchiveEpoch, cache, func(value RotationTask) error {
			task = value
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if len(task.ArchiveTargets) != 2 || task.ArchiveTargets[0].Purpose != ArchiveEpoch || task.ArchiveTargets[1].Purpose != LiveEpoch {
			t.Fatalf("wrong archive work after the device loss: %+v", task.ArchiveTargets)
		}
		if _, err := store.LoadRotationTargetPackage(ctx, resolve(reader), task.EpochRecord, task.ArchiveTargets[0]); !errors.Is(err, ErrEpochRecipients) {
			t.Fatalf("device package route returned recovery material: %v", err)
		}
		if got, err := store.LoadRotationTargetPackage(ctx, resolve(reader), task.EpochRecord, task.ArchiveTargets[1]); err != nil ||
			got.Package.RecipientID != reader.DeviceID {
			t.Fatalf("normal target package no longer usable alongside recovery material: %v", err)
		}
		if err := store.DispatchRotationRecoveryTargetPackages(ctx, resolve(reader), task.EpochRecord, task.ArchiveTargets,
			verifyEpoch, cache, func(deliveries []EpochPackageDelivery) error {
				if len(deliveries) != len(task.ArchiveTargets) {
					t.Fatalf("wrong archive target count: %d", len(deliveries))
				}
				old, following := deliveries[0], deliveries[1]
				if old.Package.RecipientID != recovery.ID || len(old.Package.Ciphertext) != RecoveryEpochPackageSize ||
					old.Epoch.Record.KeyID != task.ArchiveTargets[0].KeyID || old.TextPolicy == nil ||
					old.TextPolicy.Recipient == nil || old.TextPolicy.Recipient.Statement.RecipientID != recovery.ID {
					t.Fatalf("wrong recovery-target delivery: %+v", old)
				}
				if following.Package.RecipientID != reader.DeviceID || len(following.Package.Ciphertext) != EpochPackageSize ||
					following.Epoch.Record.KeyID != task.ArchiveTargets[1].KeyID || following.TextPolicy != nil {
					t.Fatalf("mixed batch failed to prefer an addressed device package: %+v", following)
				}
				return nil
			}); err != nil {
			t.Fatal(err)
		}
		badTarget := task.ArchiveTargets[0]
		badTarget.KeyID = strings.Repeat("b", 64)
		denyRecovery := func([]EpochPackageDelivery) error {
			t.Fatal("inactive lease or unlisted target opened a recovery package")
			return nil
		}
		if err := store.DispatchRotationRecoveryTargetPackages(ctx, resolve(reader), task.EpochRecord, []ArchiveTarget{badTarget},
			verifyEpoch, cache, denyRecovery); !errors.Is(err, ErrEpochRecipients) {
			t.Fatalf("target outside the lease accessed recovery: %v", err)
		}
		if err := store.DispatchRotationRecoveryTargetPackages(ctx, resolve(owner), task.EpochRecord, task.ArchiveTargets,
			verifyEpoch, cache, denyRecovery); !errors.Is(err, ErrRotationLease) {
			t.Fatalf("another device accessed a leased recovery target: %v", err)
		}
	})

	admitted := func(channel, key string, accept func(EpochPackageDelivery) error) error {
		return store.DispatchAdmittedRecoveryLivePackage(ctx, resolve(reader), channel, key, verifyEpoch, cache, true, accept)
	}
	oldLimitedKey := strings.Repeat("3", 64)
	if err := admitted(limited, oldLimitedKey, func(delivery EpochPackageDelivery) error {
		if delivery.Package.RecipientID != recovery.ID || delivery.Epoch.Record.Generation != 1 ||
			delivery.AdmissionPolicy == nil || delivery.AdmissionPolicy.Recipient == nil ||
			delivery.AdmissionPolicy.Recipient.Statement.FirstPosition != 7 ||
			delivery.TextPolicy == nil || delivery.TextPolicy.Recipient == nil ||
			delivery.TextPolicy.Recipient.Statement.FirstPosition != 7 {
			t.Fatalf("old live package lacks continuous admission evidence: %+v", delivery)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := admitted(public, strings.Repeat("1", 64), deny); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("history.full reader used since-joining recovery endpoint: %v", err)
	}
	if err := admitted(hidden, strings.Repeat("4", 64), deny); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("hidden live package was reachable: %v", err)
	}

	exec("UPDATE protected_epoch_packages SET ciphertext=? WHERE channel_id=? AND recipient_id=? AND purpose=? AND generation=2",
		bytes.Repeat([]byte{2}, EpochPackageSize), limited, owner.DeviceID, LiveEpoch)
	if err := read(reader, limited, LiveEpoch, deny); !errors.Is(err, ErrEpochConflict) {
		t.Fatalf("tampered Merkle sibling did not block delivery: %v", err)
	}
	if err := confirm(applied, signed, now.UnixMilli(), true); !errors.Is(err, ErrEpochConflict) {
		t.Fatalf("tampered Merkle sibling did not block recovery confirmation: %v", err)
	}
	exec("UPDATE protected_epoch_packages SET recipient_key=? WHERE channel_id=? AND recipient_id=? AND purpose=? AND generation=2",
		recoveryTestAgreementKey(t, 4), limited, recovery.ID, LiveEpoch)
	if !coverage(reader).Items[2].Pending {
		t.Fatal("packet for a different agreement key covered the current recovery identity")
	}
	applied.EpochWindows[public] = EpochWindow{Current: 1, CurrentCutoff: now.UnixMilli()}
	save(applied)
	if !coverage(reader).Items[0].Pending {
		t.Fatal("expired current live generation still counted toward coverage")
	}
	if err := read(reader, public, LiveEpoch, deny); !errors.Is(err, ErrEpochRecipients) {
		t.Fatalf("expired live generation delivered a recovery package: %v", err)
	}

	deniedACL := ACL{Profiles: map[string]Overwrite{reader.ProfileID: {Deny: []string{ChannelView}}}}
	commit(PolicyDraft{Action: UpdateChannelACL, OperationID: strings.Repeat("c", 32),
		ResourceChange: &PolicyResourceChange{ID: limited, ACL: &deniedACL}})
	duringRevoke, _, err := readState(db.QueryRow("SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		t.Fatal(err)
	}
	channel := duringRevoke.Channels[limited]
	channel.NextPosition = 8
	duringRevoke.Channels[limited] = channel
	save(duringRevoke)
	limitedACL := initial.Channels[limited].ACL
	commit(PolicyDraft{Action: UpdateChannelACL, OperationID: strings.Repeat("d", 32),
		ResourceChange: &PolicyResourceChange{ID: limited, ACL: &limitedACL}})
	if err := admitted(limited, oldLimitedKey, deny); !errors.Is(err, ErrEpochRecipients) {
		t.Fatalf("lost and restored access recovered a prior live admission: %v", err)
	}
}
