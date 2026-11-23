package access

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEpochDeadlineSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite"))
	db, _ := openTestPolicy(t, path)
	now := time.UnixMilli(1000)
	store := NewStoreWithClock(db, func() time.Time { return now })
	initial := testPolicyState()
	ownerDevice, readerDevice := strings.Repeat("1", 64), strings.Repeat("2", 64)
	initial.KeyRecipients = map[string]KeyRecipient{
		ownerDevice:  {ProfileID: "owner", Kind: "device", PublicKey: strings.Repeat("22", 32)},
		readerDevice: {ProfileID: "reader", Kind: "device", PublicKey: strings.Repeat("33", 32)},
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(context.Context, SessionQuery) (Principal, error) {
		return Principal{ProfileID: "owner", DeviceID: ownerDevice}, nil
	}
	task, err := store.ClaimRotation(ctx, resolve, "secret", LiveEpoch)
	if err != nil {
		t.Fatal(err)
	}
	record := task.EpochRecord
	record.KeyID, record.Signature = strings.Repeat("a", 64), make([]byte, 64)
	var packages []EpochPackage
	for id := range task.Recipients {
		packages = append(packages, EpochPackage{RecipientID: id, Purpose: LiveEpoch, Ciphertext: make([]byte, EpochPackageSize)})
	}
	record.PackagesDigest, err = PackagesDigest(packages)
	if err != nil {
		t.Fatal(err)
	}
	verify := func(context.Context, SessionQuery, Principal, EpochRecord) error { return nil }
	if err := store.CommitEpoch(ctx, resolve, verify, record, packages, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplyRoles(ctx, 1, "owner", initial.Roles, initial.Order, map[string][]string{"reader": nil}); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, _ := openTestPolicy(t, path)
	reopenedStore := NewStoreWithClock(reopened, func() time.Time { return now })
	rotation, err := reopenedStore.ClaimRotation(ctx, resolve, "secret", LiveEpoch)
	if err != nil || rotation.Generation != 2 || rotation.TaskID == task.TaskID {
		t.Fatalf("pending rotation lost across reopen: %+v, %v", rotation, err)
	}
	if _, err := ReadMessageEpoch(ctx, reopened, record.ChannelID, record.KeyID, 60_999); err != nil {
		t.Fatalf("reopened grace rejected early: %v", err)
	}
	if _, err := ReadMessageEpoch(ctx, reopened, record.ChannelID, record.KeyID, 61_000); !errors.Is(err, ErrEpochStale) {
		t.Fatalf("reopen extended grace: %v", err)
	}
}

func TestPolicyDigestIgnoresContentCounters(t *testing.T) {
	state := testPolicyState()
	state.refreshAdmissions()
	before, err := state.PolicyDigest()
	if err != nil {
		t.Fatal(err)
	}
	channel := state.Channels["secret"]
	channel.NextPosition++
	state.Channels["secret"] = channel
	state.EpochWindows = map[string]EpochWindow{"secret": {Current: 3}}
	after, err := state.PolicyDigest()
	if err != nil || before != after {
		t.Fatalf("operational counters changed policy digest: %v", err)
	}
	state.Admissions["secret"]["reader"] = Admission{FirstPosition: channel.NextPosition}
	after, err = state.PolicyDigest()
	if err != nil || before == after {
		t.Fatalf("changed admission was not committed by policy digest: %v", err)
	}
}
