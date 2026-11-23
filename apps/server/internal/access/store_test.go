package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	_ "modernc.org/sqlite"
)

func openTestPolicy(t *testing.T, path string) (*sql.DB, *Store) {
	t.Helper()
	db, err := sql.Open("sqlite", path+"?_txlock=immediate&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, NewStore(db)
}

func testPolicyState() State {
	return State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: "owner", Order: []string{"reader"}, Roles: map[string]Role{
				Everyone: {[]string{ChannelView}},
				"reader": {[]string{"history.full"}},
			}},
			Members: map[string]Subject{
				"owner":  {ID: "owner", Active: true},
				"reader": {ID: "reader", Active: true, Roles: []string{"reader"}},
			},
		},
		Categories: map[string]ACL{
			"private": {Roles: map[string]Overwrite{Everyone: {Deny: []string{ChannelView}}, "reader": {Allow: []string{ChannelView}}}},
		},
		Channels: map[string]Channel{
			"secret": {Kind: "text", CategoryID: "private", Synchronized: true, NextPosition: 50},
			"public": {Kind: "text", NextPosition: 50},
		},
	}
}

func TestRosterScopesMembersAndRanksRolesAcrossPages(t *testing.T) {
	state := testPolicyState()
	state.Order = []string{"junior", "reader", "featured", "other"}
	state.Roles["junior"] = Role{}
	state.Roles["featured"] = Role{}
	state.Roles["other"] = Role{}
	state.RolePresentation = map[string]RolePresentation{
		"junior":   {Color: "#486020", Hoist: true},
		"reader":   {Color: "#5a89bc", Hoist: true},
		"featured": {Name: "Featured", Hoist: true},
		"other":    {Name: "Hidden group", Hoist: true},
	}
	for n := 0; n < protectedRosterPageSize; n++ {
		id := fmt.Sprintf("%064x", n)
		state.Members[id] = Subject{ID: id, Active: true, Roles: []string{"reader", "junior", "featured"}}
	}
	state.Members["hidden"] = Subject{ID: "hidden", Active: true, Roles: []string{"other"}}
	state.Members["inactive"] = Subject{ID: "inactive", Roles: []string{"reader", "featured"}}
	page := state.roster("secret", "")
	if len(page.Members) != protectedRosterPageSize || page.Next != fmt.Sprintf("%064x", protectedRosterPageSize-1) {
		t.Fatalf("first page count = %d, next = %q", len(page.Members), page.Next)
	}
	for n, member := range page.Members {
		if member.ID != fmt.Sprintf("%064x", n) || member.GroupID != "featured" || member.GroupRank != 1 ||
			member.Color != "#5a89bc" || !slices.Equal(member.Roles, []RosterRole{
			{ID: "featured", Name: "Featured"}, {ID: "reader"}, {ID: "junior"}, {ID: Everyone},
		}) {
			t.Fatalf("member %d: %+v", n, member)
		}
	}
	last := state.roster("secret", page.Next)
	if last.Next != "" || len(last.Members) != 2 || last.Members[0].ID != "owner" ||
		last.Members[1].ID != "reader" || last.Members[1].GroupRank != 2 {
		t.Fatalf("last page: %+v", last)
	}
	global := state.roster("", page.Next)
	if len(global.Members) != 3 || global.Members[0].ID != "hidden" || global.Members[0].GroupID != "other" {
		t.Fatalf("global page: %+v", global)
	}
}

func TestCommittedRevokeFiltersPendingEventsAndMetadata(t *testing.T) {
	ctx := context.Background()
	path := filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite"))
	db, store := openTestPolicy(t, path)
	initial := testPolicyState()
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	events := []ScopedEvent{
		{ChannelID: "secret", Payload: []byte("secret metadata")},
		{ChannelID: "secret", Content: true, OriginalPosition: 8, Payload: []byte("revision of old object")},
		{ChannelID: "public", Payload: []byte("public metadata")},
		{ChannelID: "public", Content: true, Payload: []byte("missing original position")},
	}
	project, err := store.Project(ctx, "reader", events)
	if err != nil || len(project.Channels) != 2 || len(project.Events) != 3 {
		t.Fatalf("initial projection: %+v, %v", project, err)
	}
	revision, err := store.ApplyRoles(ctx, 1, "owner", initial.Roles, initial.Order, map[string][]string{"reader": nil})
	if err != nil || revision != 2 {
		t.Fatalf("revoke = %d, %v", revision, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	_, reopened := openTestPolicy(t, path)
	project, err = reopened.Project(ctx, "reader", events)
	if err != nil || len(project.Channels) != 1 || project.Channels[0].ID != "public" ||
		len(project.Events) != 1 || project.Events[0].ChannelID != "public" {
		t.Fatalf("revoked projection: %+v, %v", project, err)
	}
	if _, err := reopened.ApplyRoles(ctx, 1, "owner", initial.Roles, initial.Order, nil); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("stale preview = %v", err)
	}
}

func TestFullArchiveDispatchRechecksFullHistoryGrant(t *testing.T) {
	ctx := context.Background()
	_, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	initial := testPolicyState()
	initial.PolicyDevices = make(map[string]PolicyDevice)
	initial.KeyRecipients = make(map[string]KeyRecipient)
	actors := make(map[string]Principal)
	for profile, raw := range map[string]string{"owner": "22", "reader": "33"} {
		key := strings.Repeat(raw, 32)
		decoded, _ := hex.DecodeString(key)
		hash := sha256.Sum256(decoded)
		id := hex.EncodeToString(hash[:])
		initial.PolicyDevices[id] = PolicyDevice{ProfileID: profile, PublicKey: key}
		initial.KeyRecipients[id] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: key}
		actors[profile] = Principal{ProfileID: profile, DeviceID: id}
	}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	resolve := func(profile string) ResolveSession {
		return func(context.Context, SessionQuery) (Principal, error) { return actors[profile], nil }
	}
	commit := func(input PolicyDraft) {
		t.Helper()
		draft, err := store.PreviewPolicy(ctx, resolve("owner"), input)
		if err != nil {
			t.Fatal(err)
		}
		draft.Signature = make([]byte, 64)
		draft.Signature[0] = byte(draft.Revision)
		if _, err := store.CommitPolicy(ctx, resolve("owner"), func(context.Context, SessionQuery, Principal, PolicyDraft) error { return nil }, draft); err != nil {
			t.Fatal(err)
		}
	}
	commit(PolicyDraft{Action: AnchorPolicy, OperationID: strings.Repeat("1", 32)})
	read := false
	if err := store.DispatchFullArchive(ctx, resolve("reader"), "public", func(*sql.Conn) error { read = true; return nil }); err != nil || !read {
		t.Fatalf("reader with full history denied: %t, %v", read, err)
	}
	commit(PolicyDraft{Action: UpdatePolicyRoles, OperationID: strings.Repeat("2", 32),
		RoleUpdate: &RolePolicyUpdate{Roles: initial.Roles, Order: initial.Order, Assignments: map[string][]string{"reader": nil}}})
	if err := store.DispatchFullArchive(ctx, resolve("reader"), "public", func(*sql.Conn) error {
		t.Fatal("archive was dispatched after the history grant was removed")
		return nil
	}); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("visible channel did not reject archive delivery: %v", err)
	}
}

func TestPolicyConcurrentCommits(t *testing.T) {
	ctx := context.Background()
	path := filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite"))
	_, first := openTestPolicy(t, path)
	_, second := openTestPolicy(t, path)
	initial := testPolicyState()
	if err := first.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var clients sync.WaitGroup
	for _, store := range []*Store{first, second} {
		clients.Go(func() {
			<-start
			_, err := store.ApplyRoles(ctx, 1, "owner", initial.Roles, initial.Order, map[string][]string{"reader": nil})
			results <- err
		})
	}
	close(start)
	clients.Wait()
	close(results)
	var accepted, stale int
	for err := range results {
		switch {
		case err == nil:
			accepted++
		case errors.Is(err, ErrPolicyConflict):
			stale++
		default:
			t.Fatal(err)
		}
	}
	if accepted != 1 || stale != 1 {
		t.Fatalf("accepted %d, stale %d", accepted, stale)
	}
}

func TestRecoveryRejectionIsAtomic(t *testing.T) {
	ctx := context.Background()
	_, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	initial := testPolicyState()
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	initial.Roles["reader"] = Role{[]string{Administrator}}
	if _, err := store.ApplyRoles(ctx, 1, "owner", initial.Roles, initial.Order, nil); err == nil {
		t.Fatal("administrator was granted without recovery")
	} else {
		var denied RoleChangeFailure
		if !errors.As(err, &denied) || denied.Decision != RecoveryRequired ||
			!slices.Equal(denied.RecoveryProfiles, []string{"reader"}) {
			t.Fatal(err)
		}
	}
	state, revision, err := store.Snapshot(ctx)
	if err != nil || revision != 1 || slices.Contains(state.Roles["reader"].Grants, Administrator) {
		t.Fatalf("partial grant: %+v, %d, %v", state, revision, err)
	}
}

func TestCategoryChangesOnlySynchronizedChannels(t *testing.T) {
	ctx := context.Background()
	_, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	initial := testPolicyState()
	initial.Channels["sibling"] = initial.Channels["secret"]
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	category := initial.Categories["private"]
	if _, err := store.SetChannelACL(ctx, 1, "owner", "secret", category); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetCategoryACL(ctx, 2, "owner", "private", ACL{
		Roles: map[string]Overwrite{Everyone: {Deny: []string{ChannelView}}},
	}); err != nil {
		t.Fatal(err)
	}
	state, revision, err := store.Snapshot(ctx)
	if err != nil || revision != 3 || state.Channels["secret"].Synchronized || !state.CanDeliver("reader", "secret", 8) {
		t.Fatalf("local rules changed with category: %+v, %d, %v", state, revision, err)
	}
	if state.CanDeliver("reader", "sibling", 0) {
		t.Fatal("category revoke did not apply to synchronized sibling")
	}
}

func TestDeleteCategoryRetainsEffectiveChannelRules(t *testing.T) {
	ctx := context.Background()
	_, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	initial := testPolicyState()
	initial.Categories["private"].Roles["reader"] = Overwrite{Allow: []string{ChannelView, "voice.speak"}}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeleteCategory(ctx, 1, "owner", "private", false); err != nil {
		t.Fatal(err)
	}
	state, revision, err := store.Snapshot(ctx)
	channel := state.Channels["secret"]
	if err != nil || revision != 2 || channel.CategoryID != "" || channel.Synchronized ||
		!state.CanDeliver("reader", "secret", 8) || len(state.Categories) != 0 {
		t.Fatalf("category deletion changed channel access: %+v, %d, %v", state, revision, err)
	}
	if got := channel.ACL.Roles["reader"].Allow; !slices.Equal(got, []string{ChannelView}) {
		t.Fatalf("wrong scoped grants on detached channel: %v", got)
	}
}

func TestCategoryCascadeNeedsPermissionForEveryChild(t *testing.T) {
	ctx := context.Background()
	_, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	initial := testPolicyState()
	initial.Roles["reader"] = Role{Grants: []string{"channel.delete", "history.full"}}
	initial.CategoryNames = map[string]string{"private": "Shared category"}
	initial.Channels["blocked"] = Channel{Kind: "text", CategoryID: "private", NextPosition: 1,
		ACL: ACL{Roles: map[string]Overwrite{"reader": {Deny: []string{"channel.delete"}}}}}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DeleteCategory(ctx, 1, "reader", "private", true); !errors.Is(err, MissingGrant) {
		t.Fatalf("cascade bypassed a child permission: %v", err)
	}
	state, revision, err := store.Snapshot(ctx)
	if err != nil || revision != 1 || len(state.Channels) != len(initial.Channels) ||
		state.CategoryNames["private"] != "Shared category" || len(state.RetiredChannels) != 0 {
		t.Fatalf("failed cascade changed durable state: revision %d, %v", revision, err)
	}
}

func TestChannelOrderKeepsHiddenAndReadOnlySlots(t *testing.T) {
	state := testPolicyState()
	state.Roles["reader"] = Role{Grants: []string{"channel.edit"}}
	state.Channels = map[string]Channel{
		"a":        {Kind: "text"},
		"hidden":   {Kind: "text", ACL: ACL{Roles: map[string]Overwrite{Everyone: {Deny: []string{ChannelView}}}}},
		"readonly": {Kind: "text", ACL: ACL{Roles: map[string]Overwrite{"reader": {Deny: []string{"channel.edit"}}}}},
		"b":        {Kind: "text"},
		"voice":    {Kind: "voice"},
	}
	state.ChannelOrder = []string{"a", "hidden", "readonly", "b", "voice"}
	if err := state.reorderChannel("reader", "a", "b", true, false); err != nil {
		t.Fatal(err)
	}
	if want := []string{"b", "hidden", "readonly", "a", "voice"}; !slices.Equal(state.ChannelOrder, want) {
		t.Fatalf("hidden or noneditable slot moved: %v", state.ChannelOrder)
	}
	for _, anchor := range []string{"absent", "hidden", "readonly", "voice"} {
		if err := state.reorderChannel("reader", "a", anchor, false, false); !errors.Is(err, ChannelRestricted) {
			t.Fatalf("anchor %q returned %v", anchor, err)
		}
	}
	if err := state.reorderChannel("reader", "b", "voice", true, true); err != nil {
		t.Fatal(err)
	}
	if want := []string{"a", "hidden", "readonly", "voice", "b"}; !slices.Equal(state.ChannelOrder, want) {
		t.Fatalf("mixed order moved hidden or noneditable slots: %v", state.ChannelOrder)
	}
	view, err := project(state, "reader", nil)
	var ids []string
	for _, channel := range view.Channels {
		ids = append(ids, channel.ID)
	}
	if err != nil || !slices.Equal(ids, []string{"a", "readonly", "voice", "b"}) {
		t.Fatalf("filtered order = %v, %v", ids, err)
	}
}

func TestCategoryOrderKeepsHiddenSlotsAndCopyKeepsOriginalChannels(t *testing.T) {
	state := testPolicyState()
	state.Roles["reader"] = Role{Grants: []string{"channel.edit"}}
	state.Categories["open"] = ACL{}
	state.Categories["hidden"] = ACL{Roles: map[string]Overwrite{Everyone: {Deny: []string{ChannelView}}}}
	state.Channels["public"] = Channel{Kind: "text", CategoryID: "open", Synchronized: true}
	state.Channels["concealed"] = Channel{Kind: "text", CategoryID: "hidden", Synchronized: true}
	state.CategoryOrder = []string{"private", "hidden", "open"}
	if err := state.reorderCategory("reader", "private", "open", true); err != nil {
		t.Fatal(err)
	}
	if want := []string{"open", "hidden", "private"}; !slices.Equal(state.CategoryOrder, want) {
		t.Fatalf("hidden category slot moved: %v", state.CategoryOrder)
	}
	if err := state.reorderCategory("reader", "private", "hidden", true); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("hidden category became a reorder anchor: %v", err)
	}
	if err := state.copyCategory("owner", "copy", "private", "Copied category"); err != nil {
		t.Fatal(err)
	}
	if state.CategoryNames["copy"] != "Copied category" || state.Channels["secret"].CategoryID != "private" ||
		!slices.Equal(state.Categories["copy"].Roles["reader"].Allow, state.Categories["private"].Roles["reader"].Allow) {
		t.Fatal("category copy changed its source or failed to copy the rules")
	}
	delete(state.Categories["copy"].Roles, "reader")
	if _, exists := state.Categories["private"].Roles["reader"]; !exists {
		t.Fatal("copied rules shared the source map")
	}
}

func TestMoveChannelRequiresExplicitAccessChoice(t *testing.T) {
	ctx := context.Background()
	_, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite")))
	initial := testPolicyState()
	initial.Categories["closed"] = ACL{Roles: map[string]Overwrite{Everyone: {Deny: []string{ChannelView}}}}
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveChannel(ctx, 1, "owner", "secret", "closed", ""); !errors.Is(err, InvalidPolicy) {
		t.Fatalf("implicit move accepted: %v", err)
	}
	if _, err := store.MoveChannel(ctx, 1, "owner", "secret", "closed", PreserveAccess); err != nil {
		t.Fatal(err)
	}
	if _, err := store.MoveChannel(ctx, 2, "owner", "sibling", "closed", SynchronizeAccess); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("unknown channel moved: %v", err)
	}
	state, _, err := store.Snapshot(ctx)
	if err != nil || !state.CanDeliver("reader", "secret", 8) {
		t.Fatalf("preserve move changed access: %v", err)
	}
	if _, err := store.MoveChannel(ctx, 2, "owner", "secret", "closed", SynchronizeAccess); err != nil {
		t.Fatal(err)
	}
	state, _, err = store.Snapshot(ctx)
	if err != nil || state.CanDeliver("reader", "secret", 0) || state.Admissions["secret"]["reader"].FirstPosition != 0 {
		t.Fatalf("synchronized move did not revoke access: %v", err)
	}
}

func TestDispatchRetainsPolicyLockThroughCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path := filepath.ToSlash(filepath.Join(t.TempDir(), "policy.sqlite"))
	_, store := openTestPolicy(t, path)
	initial := testPolicyState()
	if err := store.Initialize(ctx, initial); err != nil {
		t.Fatal(err)
	}
	other, err := sql.Open("sqlite", path+"?_txlock=immediate&_pragma=busy_timeout(0)")
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	events := []ScopedEvent{{ChannelID: "secret", OriginalPosition: 8, Content: true}}
	err = store.Dispatch(ctx, "reader", events, func(projection Projection) error {
		if len(projection.Events) != 1 {
			t.Fatalf("unexpected events: %+v", projection.Events)
		}
		cancel()
		tx, err := other.BeginTx(context.Background(), nil)
		if err == nil {
			tx.Rollback()
			t.Fatal("concurrent policy writer acquired lock during dispatch")
		}
		var sqliteErr interface{ Code() int }
		if !errors.As(err, &sqliteErr) || sqliteErr.Code()&0xff != 5 { // SQLITE_BUSY
			t.Fatalf("unexpected competing writer error: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewStore(other).ApplyRoles(context.Background(), 1, "owner", initial.Roles, initial.Order,
		map[string][]string{"reader": nil}); err != nil {
		t.Fatal(err)
	}
	if err := store.Dispatch(context.Background(), "reader", events, func(projection Projection) error {
		if len(projection.Events) != 0 {
			t.Fatalf("revoked event reached writer: %+v", projection.Events)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
