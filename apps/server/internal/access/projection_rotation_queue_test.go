package access

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestVisibleRotationQueueCountsCurrentTasksAcrossRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite"))
	db, _ := openTestPolicy(t, path)
	now := time.UnixMilli(10_000)
	clock := func() time.Time { return now }
	store := NewStoreWithClock(db, clock)
	initial := testPolicyState()
	initial.Order = append(initial.Order, "operator")
	initial.Roles["operator"] = Role{Grants: []string{Administrator}}
	initial.Members["reader"] = Subject{ID: "reader", Active: true}
	initial.Members["operator"] = Subject{ID: "operator", Active: true, Roles: []string{"operator"}}
	initial.Channels["another"] = Channel{Kind: "text", NextPosition: 1}
	initial.Channels["third"] = Channel{Kind: "text", NextPosition: 1}
	initial.PolicyDevices = make(map[string]PolicyDevice)
	principals := make(map[string]Principal)
	for profile, seed := range map[string]byte{"owner": 1, "reader": 2, "operator": 3} {
		key := []byte(strings.Repeat(string(rune(seed)), 32))
		deviceID := hexHash(key)
		principals[profile] = Principal{ProfileID: profile, DeviceID: deviceID}
		initial.PolicyDevices[deviceID] = PolicyDevice{ProfileID: profile, PublicKey: hex.EncodeToString(key)}
	}
	resolve := func(profile string) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return principals[profile], nil }
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	// The full Server schema already provides the legacy device registry.
	if _, err := db.ExecContext(ctx, "CREATE TABLE devices (device_id TEXT PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	anchor, err := store.PreviewPolicy(ctx, resolve("owner"), PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("a", 32)})
	if err != nil {
		t.Fatal(err)
	}
	anchor.Signature = make([]byte, 64)
	if _, err := store.CommitPolicy(ctx, resolve("owner"), func(context.Context, SessionQuery, Principal, PolicyDraft) error {
		return nil
	}, anchor); err != nil {
		t.Fatal(err)
	}
	// Include another device's live lease, an expired lease, and a hidden
	// channel's lease. Readers have no key material to execute any task.
	lease := func(channel, purpose string, until int64) {
		t.Helper()
		_, err := db.ExecContext(ctx, `UPDATE protected_rotation_tasks SET lease_device=?,lease_id=?,lease_until=?
			WHERE channel_id=? AND purpose=?`, principals["owner"].DeviceID, strings.Repeat("b", 32), until, channel, purpose)
		if err != nil {
			t.Fatal(err)
		}
	}
	lease("public", LiveEpoch, now.Add(time.Second).UnixMilli())
	lease("public", ArchiveEpoch, now.UnixMilli())
	lease("secret", LiveEpoch, now.Add(time.Minute).UnixMilli())

	check := func(profile string, waiting, processing, channels int) {
		t.Helper()
		called := false
		if err := store.DispatchVisibleState(ctx, resolve(profile), func(view Projection) error {
			called = true
			if len(view.Channels) != channels || view.RotationQueue == nil ||
				*view.RotationQueue != (RotationQueueSummary{Waiting: waiting, Processing: processing}) {
				t.Fatalf("%s: unexpected projected state: %+v, queue=%+v", profile, view, view.RotationQueue)
			}
			raw, err := json.Marshal(view)
			if err != nil {
				return err
			}
			var wire map[string]json.RawMessage
			if err := json.Unmarshal(raw, &wire); err != nil {
				return err
			}
			var summary map[string]int
			if err := json.Unmarshal(wire["rotationQueue"], &summary); err != nil {
				return err
			}
			if len(summary) != 2 || summary["waiting"] != waiting || summary["processing"] != processing {
				t.Fatalf("unexpected projection wire summary: %s", wire["rotationQueue"])
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if !called {
			t.Fatal("projection did not deliver")
		}
	}
	check("reader", 5, 1, 3)
	check("owner", 6, 2, 4)
	check("operator", 6, 2, 4)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, _ = openTestPolicy(t, path)
	store = NewStoreWithClock(db, clock)
	now = now.Add(time.Second)
	check("reader", 6, 0, 3)
	check("owner", 7, 1, 4)
	if _, err := db.ExecContext(ctx, "DELETE FROM protected_rotation_tasks"); err != nil {
		t.Fatal(err)
	}
	check("reader", 0, 0, 3)
}
