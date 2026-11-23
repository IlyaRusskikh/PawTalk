package access

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestStartupReplaysScopedPolicyAuthority(t *testing.T) {
	state := testPolicyState()
	state.Roles["reader"] = Role{Grants: []string{"history.full", "channel.edit"}}
	state.Categories["private"] = ACL{Roles: map[string]Overwrite{
		"reader": {Deny: []string{ChannelView, "channel.edit"}},
	}}
	state.PolicyDevices = make(map[string]PolicyDevice)
	addDevice := func(profile, seed string) Principal {
		raw, err := hex.DecodeString(strings.Repeat(seed, 32))
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(raw)
		id := hex.EncodeToString(digest[:])
		state.PolicyDevices[id] = PolicyDevice{ProfileID: profile, PublicKey: hex.EncodeToString(raw)}
		return Principal{ProfileID: profile, DeviceID: id}
	}
	owner, reader := addDevice("owner", "01"), addDevice("reader", "02")
	state, err := normalizeInitialState(state)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := state.policySnapshotBytes()
	if err != nil {
		t.Fatal(err)
	}
	result, err := state.PolicyDigest()
	if err != nil {
		t.Fatal(err)
	}
	head := PolicyProof{Draft: PolicyDraft{Revision: 1, ResultDigest: result}, Digest: strings.Repeat("a", 64)}
	readInitial := func() State {
		t.Helper()
		var snapshot State
		if err := json.Unmarshal(initial, &snapshot); err != nil {
			t.Fatal(err)
		}
		return snapshot
	}
	prepare := func(actor Principal, request PolicyDraft) (State, PolicyProof) {
		t.Helper()
		before := readInitial()
		before.PolicyAnchored = true
		for id, channel := range before.Channels {
			channel.NextPosition = 75
			before.Channels[id] = channel
		}
		draft, err := preparePolicyDraft(&before, 1, head, actor, request)
		if err != nil {
			t.Fatal(err)
		}
		return before, PolicyProof{Draft: draft, Principal: actor}
	}
	settings := &ChannelSettings{Name: "New name"}
	request := PolicyDraft{Action: EditPolicyChannel, OperationID: strings.Repeat("b", 32),
		ResourceChange: &PolicyResourceChange{ID: "public", Settings: settings}}
	open, delegated := prepare(reader, request)
	floor := map[string]uint64{"public": 50, "secret": 50}
	if err := replayActivatedPolicy(readInitial(), head, open, delegated, floor); err != nil {
		t.Fatalf("approved channel edit rejected: %v", err)
	}
	request.ResourceChange = &PolicyResourceChange{ID: "secret", Settings: settings}
	closed, restricted := prepare(owner, request)
	restricted.Principal = reader
	if err := replayActivatedPolicy(readInitial(), head, closed, restricted, floor); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("editor was accepted outside their channel: %v", err)
	}
	request.Action = UpdateChannelACL
	request.ResourceChange = &PolicyResourceChange{ID: "secret", ACL: &ACL{}}
	admitted, admission := prepare(owner, request)
	if got := admitted.Admissions["secret"]["reader"].FirstPosition; got != 75 {
		t.Fatalf("fixture did not produce an admission at the live position: %d", got)
	}
	if err := replayActivatedPolicy(readInitial(), head, admitted, admission, floor); err != nil {
		t.Fatalf("approved admission at a non-genesis position rejected: %v", err)
	}
	admitted.Admissions["secret"]["reader"] = Admission{FirstPosition: 49}
	admission.Draft.ResultDigest, err = admitted.PolicyDigest()
	if err != nil {
		t.Fatal(err)
	}
	if err := replayActivatedPolicy(readInitial(), head, admitted, admission, floor); !errors.Is(err, ErrPolicyConflict) {
		t.Fatalf("admission before the already witnessed position was accepted: %v", err)
	}
}
