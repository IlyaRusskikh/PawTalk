package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pawtalk/server/internal/access"
)

func TestProtectedChannelPolicyCommitmentInteroperability(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	visible, hidden := strings.Repeat("a", 32), strings.Repeat("b", 32)
	store := testMembershipStore(t)
	_, state, owner, reader := protectedTestStateWith(t, store, func(state *access.State) {
		state.Roles["reader"] = access.Role{Grants: []string{access.ChannelView}}
		state.Channels = map[string]access.Channel{
			visible: {Kind: "text", NextPosition: 1},
			hidden: {Kind: "text", NextPosition: 1, Settings: &access.ChannelSettings{Name: "Hidden test channel"},
				ACL: access.ACL{Roles: map[string]access.Overwrite{"reader": {Deny: []string{access.ChannelView}}}}},
		}
	})
	recovery := strings.Repeat("9", 64)
	state.KeyRecipients[recovery] = access.KeyRecipient{Kind: "recovery", ProfileID: owner.Access.EffectiveProfileID, PublicKey: testRecipientKey(t, 33)}
	digests, err := state.TextChannelKeyDigests()
	if err != nil {
		t.Fatal(err)
	}
	disclosed, err := state.TextChannelKeyProjection(visible)
	if err != nil {
		t.Fatal(err)
	}
	if len(disclosed.Recipients) != 3 {
		t.Fatalf("unexpected recipient count: %d", len(disclosed.Recipients))
	}
	for _, entry := range disclosed.Recipients {
		if entry.Archive != (entry.ProfileID == owner.Access.EffectiveProfileID) {
			t.Fatal("archive eligibility differs from effective history access")
		}
	}
	if private, err := state.TextChannelKeyProjection(hidden); err != nil || len(private.Recipients) != 2 {
		t.Fatalf("closed channel includes an excluded reader: %+v, %v", private, err)
	}
	seed := [32]byte{31, 2}
	root, proof, err := access.ChannelPolicyCommitment(digests, seed, visible)
	if err != nil {
		t.Fatal(err)
	}
	_, single, err := access.ChannelPolicyCommitment(map[string]string{visible: digests[visible]}, seed, visible)
	if err != nil || len(single.Siblings) != len(proof.Siblings) {
		t.Fatal("proof depth changed with the channel count")
	}
	if _, _, err := access.ChannelPolicyCommitment(digests, seed, "absent"); !errors.Is(err, access.ChannelRestricted) {
		t.Fatalf("unexpected result for missing channel: %v", err)
	}
	raw, err := json.Marshal(map[string]any{"root": root, "proof": proof, "snapshot": state, "projection": disclosed,
		"visible": visible, "hidden": hidden, "seed": seed[:], "readerDevice": reader.Access.DeviceID})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, filepath.Join("..", "client", "windows", "scripts", "protected-channel-policy-integration.cjs"))
	hideWindow(command)
	command.Stdin = bytes.NewReader(raw)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("channel key projection interoperability: %v\n%s", err, output)
	}
}
