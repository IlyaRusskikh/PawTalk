package access

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestRuntimeRecoveryRotationPackageFormats(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	store := NewStoreWithClock(db, func() time.Time { return time.UnixMilli(1_000) })
	initial := testPolicyState()
	device, legacy, runtime := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64)
	legacyAgreement, runtimeAgreement := recoveryTestAgreementKey(t, 21), recoveryTestAgreementKey(t, 22)
	initial.KeyRecipients = map[string]KeyRecipient{
		device:  {ProfileID: "owner", Kind: "device", PublicKey: recoveryTestAgreementKey(t, 20)},
		legacy:  {ProfileID: "owner", Kind: "recovery", PublicKey: legacyAgreement},
		runtime: {ProfileID: "reader", Kind: "recovery", PublicKey: runtimeAgreement},
	}
	initial.RecoveryReady = map[string]bool{"owner": true}
	initial.RecoveryIdentities = map[string]RecoveryIdentity{
		"reader": {ID: runtime, SigningKey: strings.Repeat("4", 64), AgreementKey: runtimeAgreement},
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(context.Context, SessionQuery) (Principal, error) {
		return Principal{ProfileID: "owner", DeviceID: device}, nil
	}
	verify := func(context.Context, SessionQuery, Principal, EpochRecord) error { return nil }
	public := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	packet144 := append(bytes.Repeat([]byte{6}, RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize), public...)
	for _, purpose := range []string{LiveEpoch, ArchiveEpoch} {
		t.Run(purpose, func(t *testing.T) {
			task, err := store.ClaimRotation(ctx, resolve, "public", purpose)
			if err != nil || !slices.Equal(task.OpeningProofRecipients, []string{runtime}) {
				t.Fatalf("wrong recovery opening-proof hint: %v, %v", task.OpeningProofRecipients, err)
			}
			packages := []EpochPackage{
				{RecipientID: device, Purpose: purpose, Ciphertext: bytes.Repeat([]byte{1}, EpochPackageSize)},
				{RecipientID: legacy, Purpose: purpose, Ciphertext: bytes.Repeat([]byte{2}, EpochPackageSize)},
				{RecipientID: runtime, Purpose: purpose, Ciphertext: packet144},
			}
			record := task.EpochRecord
			record.KeyID, record.Signature = hexHash([]byte(purpose)), bytes.Repeat([]byte{5}, ed25519.SignatureSize)
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
			commit := func(packets []EpochPackage) error {
				t.Helper()
				digest, err := PackagesDigest(packets)
				if err != nil {
					t.Fatal(err)
				}
				record.PackagesDigest = digest
				return store.CommitEpoch(ctx, resolve, verify, record, packets, links)
			}
			for _, candidate := range []struct {
				index  int
				packet []byte
			}{
				{0, packet144},
				{1, packet144},
				{2, packet144[:EpochPackageSize]},
				{2, make([]byte, RecoveryEpochPackageSize)},
			} {
				invalid := slices.Clone(packages)
				invalid[candidate.index].Ciphertext = candidate.packet
				if err := commit(invalid); !errors.Is(err, ErrEpochRecipients) {
					t.Fatalf("commit accepted invalid packet format for recipient %d: %v", candidate.index, err)
				}
			}
			if err := commit(packages); err != nil {
				t.Fatal(err)
			}
			for _, item := range packages {
				var stored []byte
				if err := db.QueryRow(`SELECT ciphertext FROM protected_epoch_packages
					WHERE channel_id='public' AND purpose=? AND generation=1 AND recipient_id=?`,
					purpose, item.RecipientID).Scan(&stored); err != nil || !bytes.Equal(stored, item.Ciphertext) {
					t.Fatalf("stored epoch changed an envelope for %s: %v", item.RecipientID, err)
				}
				digest, proof, err := ProveEpochPackage(packages, item.RecipientID, purpose)
				if err != nil || digest != record.PackagesDigest || proof.Count != 3 {
					t.Fatalf("invalid inclusion in mixed package manifest for %s: %+v, %v", item.RecipientID, proof, err)
				}
			}
			altered := slices.Clone(packages)
			altered[2].Ciphertext = bytes.Clone(packet144)
			altered[2].Ciphertext[len(packet144)-1] ^= 1
			digest, err := PackagesDigest(altered)
			if err != nil || digest == record.PackagesDigest {
				t.Fatalf("epoch commitment omitted the opening key: %s, %v", digest, err)
			}
		})
	}
}

func TestLegacyEpochPackageCommitmentUnchanged(t *testing.T) {
	recipient := bytes.Repeat([]byte{0x7a}, 32)
	ciphertext := bytes.Repeat([]byte{0x13}, EpochPackageSize)
	leaf := sha256.Sum256(append(append([]byte{0, 1}, recipient...), ciphertext...))
	oldRoot := sha256.Sum256(append([]byte{2, 0, 0, 0, 1}, leaf[:]...))
	digest, err := PackagesDigest([]EpochPackage{{RecipientID: hex.EncodeToString(recipient), Purpose: LiveEpoch, Ciphertext: ciphertext}})
	if err != nil || digest != hex.EncodeToString(oldRoot[:]) {
		t.Fatalf("legacy leaf gained padding or a format tag: %s, %v", digest, err)
	}
}

func TestRecoveryEpochOpeningKeyRejectsDegenerateEncodings(t *testing.T) {
	for _, encoded := range []string{
		zeroKey,
		"0100000000000000000000000000000000000000000000000000000000000000",
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	} {
		key, err := hex.DecodeString(encoded)
		if err != nil || ValidRecoveryEpochOpeningKey(key) {
			t.Fatalf("accepted noncanonical or low-order opening public key %q: %v", encoded, err)
		}
	}
	public := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	if !ValidRecoveryEpochOpeningKey(public) {
		t.Fatal("rejected a generated opening public key")
	}
}

func TestQueueRecoveryOpeningUpgradesPreservesSignedEpochsAndLeases(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	now := time.UnixMilli(1_000)
	store := NewStoreWithClock(db, func() time.Time { return now })
	state := testPolicyState()
	device, runtime := strings.Repeat("1", 64), strings.Repeat("2", 64)
	deviceKey, recoveryKey := recoveryTestAgreementKey(t, 71), recoveryTestAgreementKey(t, 72)
	state.KeyRecipients = map[string]KeyRecipient{
		device:  {ProfileID: "owner", Kind: "device", PublicKey: deviceKey},
		runtime: {ProfileID: "reader", Kind: "recovery", PublicKey: recoveryKey},
	}
	state.RecoveryIdentities = map[string]RecoveryIdentity{
		"reader": {ID: runtime, SigningKey: strings.Repeat("a", 64), AgreementKey: recoveryKey},
	}
	state.Channels["limited"] = Channel{Kind: "text", NextPosition: 50, ACL: ACL{
		Profiles: map[string]Overwrite{"reader": {Deny: []string{"history.full"}}},
	}}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	state, _, err := readState(db.QueryRow("SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		t.Fatal(err)
	}
	policyDigest, err := state.PolicyDigest()
	if err != nil {
		t.Fatal(err)
	}
	public := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize)).Public().(ed25519.PublicKey)
	packet144 := append(bytes.Repeat([]byte{8}, RecoveryEpochPackageSize-RecoveryEpochOpeningKeySize), public...)
	state.EpochWindows = map[string]EpochWindow{"public": {Current: 1}, "limited": {Current: 1}}
	state.ArchiveHeads = map[string]uint64{"public": 1, "limited": 1}
	var oldRecord []byte
	var oldDigest string
	for i, historical := range []struct {
		channel string
		purpose string
		packet  []byte
	}{
		{"public", LiveEpoch, bytes.Repeat([]byte{2}, EpochPackageSize)},
		{"public", ArchiveEpoch, bytes.Repeat([]byte{3}, EpochPackageSize)},
		{"limited", LiveEpoch, packet144},
		{"limited", ArchiveEpoch, bytes.Repeat([]byte{4}, EpochPackageSize)},
	} {
		packets := []EpochPackage{
			{RecipientID: device, Purpose: historical.purpose, Ciphertext: bytes.Repeat([]byte{1}, EpochPackageSize)},
			{RecipientID: runtime, Purpose: historical.purpose, Ciphertext: historical.packet},
		}
		root, err := PackagesDigest(packets)
		if err != nil {
			t.Fatal(err)
		}
		signature := bytes.Repeat([]byte{byte(i + 5)}, ed25519.SignatureSize)
		record := EpochRecord{Purpose: historical.purpose, ChannelID: historical.channel, Generation: 1,
			Revision: 1, PolicyDigest: policyDigest, KeyID: hexHash(append([]byte("previous key"), signature...)),
			TaskID: strings.Repeat(string(rune('1'+i)), 32), PackagesDigest: root, Signature: signature}
		proof, err := json.Marshal(EpochProof{Principal: Principal{ProfileID: "owner", DeviceID: device}, Record: record})
		if err != nil {
			t.Fatal(err)
		}
		digest := hexHash(signature)
		if _, err := db.Exec(`INSERT INTO protected_epochs(channel_id,purpose,generation,key_id,task_id,digest,record)
			VALUES(?,?,1,?,?,?,?)`, record.ChannelID, record.Purpose, record.KeyID, record.TaskID, digest, proof); err != nil {
			t.Fatal(err)
		}
		if historical.channel == "public" && historical.purpose == LiveEpoch {
			oldRecord, oldDigest = proof, digest
		}
		for n, item := range packets {
			key := []string{deviceKey, recoveryKey}[n]
			if _, err := db.Exec(`INSERT INTO protected_epoch_packages(channel_id,purpose,generation,recipient_id,recipient_key,ciphertext)
				VALUES(?,?,1,?,?,?)`, historical.channel, historical.purpose, item.RecipientID, key, item.Ciphertext); err != nil {
				t.Fatal(err)
			}
		}
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE protected_policy SET snapshot=? WHERE id=1; DELETE FROM protected_rotation_tasks", raw); err != nil {
		t.Fatal(err)
	}
	queue := func() {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if err := QueueRecoveryOpeningUpgrades(ctx, tx, now.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	countTasks := func(channel string) int {
		t.Helper()
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM protected_rotation_tasks WHERE channel_id=?", channel).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	queue()
	if countTasks("public") != 2 || countTasks("limited") != 0 {
		t.Fatal("upgrade queued unrelated, forbidden, or already upgraded packages")
	}
	resolve := func(context.Context, SessionQuery) (Principal, error) {
		return Principal{ProfileID: "owner", DeviceID: device}, nil
	}
	claim := func() RotationTask {
		t.Helper()
		task, err := store.ClaimRotation(ctx, resolve, "public", LiveEpoch)
		if err != nil || task.Generation != 2 || !slices.Equal(task.OpeningProofRecipients, []string{runtime}) {
			t.Fatalf("next rotation generation missing: %+v, %v", task, err)
		}
		return task
	}
	task := claim()
	queue()
	repeat := claim()
	if repeat.TaskID != task.TaskID || repeat.LeaseID != task.LeaseID || repeat.LeaseUntil != task.LeaseUntil {
		t.Fatal("repeat upgrade replaced the existing active rotation lease")
	}
	packages := []EpochPackage{
		{RecipientID: device, Purpose: LiveEpoch, Ciphertext: make([]byte, EpochPackageSize)},
		{RecipientID: runtime, Purpose: LiveEpoch, Ciphertext: packet144},
	}
	record := task.EpochRecord
	record.KeyID, record.Signature = hexHash([]byte("upgrade key")), bytes.Repeat([]byte{0x77}, ed25519.SignatureSize)
	record.PackagesDigest, err = PackagesDigest(packages)
	if err != nil {
		t.Fatal(err)
	}
	verify := func(context.Context, SessionQuery, Principal, EpochRecord) error { return nil }
	if err := store.CommitEpoch(ctx, resolve, verify, record, packages, nil); err != nil {
		t.Fatal(err)
	}
	queue()
	if countTasks("public") != 1 {
		t.Fatal("upgrade recreated a completed live task or removed the pending archive task")
	}
	var storedRecord []byte
	var storedDigest string
	err = db.QueryRow("SELECT record,digest FROM protected_epochs WHERE channel_id='public' AND purpose='live' AND generation=1").
		Scan(&storedRecord, &storedDigest)
	if err != nil || !bytes.Equal(storedRecord, oldRecord) || storedDigest != oldDigest {
		t.Fatalf("upgrade rewrote a signed historical epoch: %v", err)
	}
}
