package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProtectedChecklistRespectsParticipationAndRetries(t *testing.T) {
	ctx := context.Background()
	db, _ := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	now := time.Unix(1000, 0)
	store := NewStoreWithClock(db, func() time.Time { return now })
	state := testPolicyState()
	state.Roles["reader"] = Role{Grants: []string{"history.full", "checklist.check"}}
	reader := state.Members["reader"]
	reader.TimeoutUntil = now.Add(time.Minute).UnixMilli()
	state.Members["reader"] = reader
	state.PolicyDevices = make(map[string]PolicyDevice)
	state.KeyRecipients = make(map[string]KeyRecipient)
	principals := make(map[string]Principal)
	for profile, seed := range map[string]byte{"owner": 1, "reader": 2} {
		key := []byte(strings.Repeat(string(rune(seed)), 32))
		public := hex.EncodeToString(key)
		digest := sha256.Sum256(key)
		device := hex.EncodeToString(digest[:])
		principals[profile] = Principal{ProfileID: profile, DeviceID: device}
		state.PolicyDevices[device] = PolicyDevice{ProfileID: profile, PublicKey: public}
		state.KeyRecipients[device] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: public}
	}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	resolve := func(profile string) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return principals[profile], nil }
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
	item, originalChecked := strings.Repeat("b", 32), strings.Repeat("c", 32)
	lookup := func(_ context.Context, _ SessionQuery, channel string, position uint64) (ChecklistDefinition, error) {
		if channel != "public" || position < 1 || position > 2 {
			return ChecklistDefinition{}, sql.ErrNoRows
		}
		return ChecklistDefinition{Author: "owner", Everyone: position == 1, Items: []string{item, originalChecked},
			Checked: map[string]bool{originalChecked: true}}, nil
	}
	read := func(channel string, position uint64, canCheck bool) error {
		return store.DispatchChecklist(ctx, resolve("reader"), lookup, channel, position, func(current ChecklistState) error {
			if current.CanCheck != canCheck || !current.Checked[originalChecked] {
				t.Fatalf("incorrect checklist state: %+v", current)
			}
			return nil
		})
	}
	set := func(profile string, position uint64, change ChecklistChange) (ChecklistState, error) {
		return store.ChangeChecklist(ctx, resolve(profile), lookup, "public", position, change)
	}
	change := ChecklistChange{OperationID: strings.Repeat("d", 32), Item: item, Checked: true}
	if err := read("public", 1, false); err != nil {
		t.Fatal(err)
	}
	if _, err := set("reader", 1, change); !errors.Is(err, TimedOut) {
		t.Fatalf("timeout allowed participation: %v", err)
	}
	now = now.Add(time.Minute)
	if err := read("public", 1, true); err != nil {
		t.Fatal(err)
	}
	if err := read("public", 2, false); err != nil {
		t.Fatal(err)
	}
	if err := read("secret", 1, false); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("another channel resolved checklist: %v", err)
	}
	if _, err := set("reader", 2, change); !errors.Is(err, MissingGrant) {
		t.Fatalf("author-only list accepted reader: %v", err)
	}
	first, err := set("reader", 1, change)
	if err != nil || first.Revision != 1 || !first.Checked[item] {
		t.Fatalf("read-only participant could not check item: %+v, %v", first, err)
	}
	revert := ChecklistChange{OperationID: strings.Repeat("e", 32), Item: item, Checked: false}
	if second, err := set("owner", 1, revert); err != nil || second.Revision != 2 || second.Checked[item] {
		t.Fatalf("subsequent uncheck failed: %+v, %v", second, err)
	}
	if retry, err := set("reader", 1, change); err != nil || retry.Revision != 2 || retry.Checked[item] {
		t.Fatalf("retry overwrote a later change: %+v, %v", retry, err)
	}
	change.Checked = false
	if _, err := set("reader", 1, change); !errors.Is(err, ErrMessageConflict) {
		t.Fatalf("receipt accepted a different operation: %v", err)
	}
	attempt := MessageAttempt{ChannelID: "public", OperationID: strings.Repeat("1", 32), KeyID: strings.Repeat("2", 64),
		Nonce: make([]byte, 12), Ciphertext: make([]byte, 17), Signature: make([]byte, 64),
		Checklist: &MessageChecklist{Items: []string{item}}}
	verify := func(context.Context, SessionQuery, Principal, int64, MessageAttempt) error { return nil }
	if _, err := store.AppendMessage(ctx, resolve("reader"), verify, attempt, false); !errors.Is(err, MissingGrant) {
		t.Fatalf("read-only member created a checklist: %v", err)
	}
	state.Roles["reader"] = Role{Grants: []string{"history.full", "message.send"}}
	draft, err := store.PreviewPolicy(ctx, resolve("owner"), PolicyDraft{Action: UpdatePolicyRoles, OperationID: strings.Repeat("f", 32),
		RoleUpdate: &RolePolicyUpdate{Roles: state.Roles, Order: state.Order}})
	if err != nil {
		t.Fatal(err)
	}
	draft.Signature = make([]byte, 64)
	if _, err := store.CommitPolicy(ctx, resolve("owner"), func(context.Context, SessionQuery, Principal, PolicyDraft) error {
		return nil
	}, draft); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AppendMessage(ctx, resolve("reader"), verify, attempt, false); !errors.Is(err, MissingGrant) {
		t.Fatalf("Send alone allowed checklist creation: %v", err)
	}
	attempt.Checklist = nil
	attempt.Poll = &MessagePoll{OptionCount: 2, Duration: 3600}
	if _, err := store.AppendMessage(ctx, resolve("reader"), verify, attempt, false); !errors.Is(err, MissingGrant) {
		t.Fatalf("Send alone allowed poll creation: %v", err)
	}
	attempt.Poll = nil
	if _, err := store.AppendMessage(ctx, resolve("reader"), verify, attempt, false); err != nil {
		t.Fatalf("failed checklist did not leave message position and nonce usable: %v", err)
	}
}
