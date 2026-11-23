package access

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"testing"
)

func TestVoiceRecipientProjection(t *testing.T) {
	voice, other := "voice", "other"
	seed := sha256.Sum256([]byte("voice-projection-vector"))
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy:  Policy{Roles: map[string]Role{Everyone: {Grants: []string{ChannelView, "voice.connect"}}}},
			Members: map[string]Subject{},
		},
		Channels: map[string]Channel{
			voice: {Kind: "voice", ACL: ACL{Profiles: map[string]Overwrite{}}},
			other: {Kind: "voice"},
		},
		PolicyDevices:     make(map[string]PolicyDevice),
		KeyRecipients:     make(map[string]KeyRecipient),
		VoiceRestrictions: map[string]map[string]VoiceRestriction{voice: {}},
	}
	add := func(i int) VoiceKeyRecipient {
		t.Helper()
		profile, agreement := fmt.Sprintf("%064x", i), fmt.Sprintf("%064x", i+10)
		key := sha256.Sum256([]byte(fmt.Sprintf("fixture voice signer %d", i)))
		device := hexHash(key[:])
		state.Members[profile] = Subject{ID: profile, Active: true}
		state.PolicyDevices[device] = PolicyDevice{ProfileID: profile, PublicKey: hex.EncodeToString(key[:])}
		state.KeyRecipients[device] = KeyRecipient{ProfileID: profile, Kind: "device", PublicKey: agreement}
		return VoiceKeyRecipient{DeviceID: device, ProfileID: profile, PublicKey: agreement}
	}
	owner, listener, muted := add(1), add(2), add(3)
	state.Owner = owner.ProfileID
	state.VoiceRestrictions[voice][muted.ProfileID] = VoiceRestriction{Muted: true}
	timed := state.Members[listener.ProfileID]
	timed.TimeoutUntil = 10_000
	state.Members[listener.ProfileID] = timed
	deafened := add(4)
	state.VoiceRestrictions[voice][deafened.ProfileID] = VoiceRestriction{Deafened: true}
	hidden := add(5)
	state.Channels[voice].ACL.Profiles[hidden.ProfileID] = Overwrite{Deny: []string{ChannelView}}
	connectDenied := add(6)
	state.Channels[voice].ACL.Profiles[connectDenied.ProfileID] = Overwrite{Deny: []string{"voice.connect"}}
	revoked := add(7)
	device := state.PolicyDevices[revoked.DeviceID]
	device.Revoked = true
	state.PolicyDevices[revoked.DeviceID] = device
	recovery := add(8)
	state.KeyRecipients[recovery.DeviceID] = KeyRecipient{ProfileID: recovery.ProfileID, Kind: "recovery", PublicKey: recovery.PublicKey}

	roster := []VoiceKeyRecipient{muted, listener, owner}
	root, proofs, err := state.voiceRecipientCommitment(voice, seed, roster)
	if err != nil {
		t.Fatal(err)
	}
	const expected = "51cf65a624cbe815319859e96246a140e116f8955cd4a0a7fd176c6733511df6"
	if root != expected {
		t.Fatalf("v8 voice root = %s, expected %s", root, expected)
	}
	state.VoiceRestrictions[serverVoiceRestriction] = map[string]VoiceRestriction{muted.ProfileID: {MediaDeafened: true}}
	mediaOnlyRoot, _, err := state.voiceRecipientCommitment(voice, seed, roster)
	if err != nil || mediaOnlyRoot != root {
		t.Fatalf("media-only deafen changed the key commitment: %s, %v", mediaOnlyRoot, err)
	}
	state.PolicyAnchored = true
	admission, err := state.voiceAdmission(Principal{ProfileID: muted.ProfileID, DeviceID: muted.DeviceID}, voice, 0)
	state.PolicyAnchored = false
	if err != nil || admission.CanSpeak || admission.CanReceive || !admission.CanReceiveKey {
		t.Fatalf("media-only deafen did not separate media and key permissions: %+v, %v", admission, err)
	}
	delete(state.VoiceRestrictions, serverVoiceRestriction)
	plainRoot, _, err := state.voiceRecipientCommitment(voice, seed, nil)
	if err != nil || plainRoot != root || len(proofs) != len(roster) {
		t.Fatalf("selective and root-only proofs differ: %s, %v", plainRoot, err)
	}
	for i, member := range roster {
		proof := proofs[i]
		if proof.DeviceID != member.DeviceID || proof.SigningKey != state.PolicyDevices[member.DeviceID].PublicKey ||
			proof.Proof.Count != 3 || verifyVoiceFixtureProof(t, member, proof) != root {
			t.Fatalf("wrong proof for roster index %d: %+v", i, proof)
		}
	}
	for _, denied := range []VoiceKeyRecipient{deafened, hidden, connectDenied, revoked, recovery} {
		if _, _, err := state.voiceRecipientCommitment(voice, seed, []VoiceKeyRecipient{denied}); !errors.Is(err, ErrEpochRecipients) {
			t.Fatalf("released a proof for denied recipient: %v", err)
		}
	}
	forged := listener
	forged.PublicKey = owner.PublicKey
	if _, _, err := state.voiceRecipientCommitment(voice, seed, []VoiceKeyRecipient{forged}); !errors.Is(err, ErrEpochRecipients) {
		t.Fatalf("proved mismatched key: %v", err)
	}
	otherRoot, _, err := state.voiceRecipientCommitment(other, seed, nil)
	if err != nil || otherRoot == root {
		t.Fatalf("voice roots are not separated by channel: %s, %v", otherRoot, err)
	}

	seedHex := hex.EncodeToString(seed[:])
	head7, err := state.textProjectionRoot(seedHex, TextOrderAuthorityVersion)
	if err != nil {
		t.Fatal(err)
	}
	head8, err := state.textProjectionRoot(seedHex, VoiceRecipientProjectionVersion)
	if err != nil || head7 == head8 {
		t.Fatalf("voice recipients did not change v8 projection: %s, %v", head8, err)
	}
	order, err := orderAuthorityDisclosure(state, PolicyProof{Draft: PolicyDraft{
		Revision: 1, TextProjectionVersion: VoiceRecipientProjectionVersion, TextProjectionSeed: seedHex, TextProjectionRoot: head8,
	}}, voice, owner.DeviceID, &textChannelPolicyTreeCache{})
	if err != nil || order.TextDigest != root {
		t.Fatalf("voice order proof omitted recipient root: %+v, %v", order, err)
	}
	state.VoiceRestrictions[voice][listener.ProfileID] = VoiceRestriction{Deafened: true}
	after7, err := state.textProjectionRoot(seedHex, TextOrderAuthorityVersion)
	if err != nil || after7 != head7 {
		t.Fatalf("voice change affected legacy policy proof: %s, %v", after7, err)
	}
	after8, err := state.textProjectionRoot(seedHex, VoiceRecipientProjectionVersion)
	if err != nil || after8 == head8 {
		t.Fatalf("deafening did not rotate v8 projection: %s, %v", after8, err)
	}
	state.KeyRecipients = nil
	empty, _, err := state.voiceRecipientCommitment(voice, seed, nil)
	if err != nil || empty != countedCommitmentRoot(0, [32]byte{}) {
		t.Fatalf("wrong empty voice commitment: %s, %v", empty, err)
	}
}

func verifyVoiceFixtureProof(t *testing.T, member VoiceKeyRecipient, inclusion VoiceRecipientInclusion) string {
	t.Helper()
	frame, err := SignatureFrame("pawtalk-voice-recipient-v1", member.DeviceID, member.ProfileID,
		member.PublicKey, inclusion.SigningKey, inclusion.Salt)
	if err != nil {
		t.Fatal(err)
	}
	node := sha256.Sum256(frame)
	index, size := inclusion.Proof.Index, inclusion.Proof.Count
	siblings := slices.Clone(inclusion.Proof.Siblings)
	for size > 1 {
		if index^1 < size {
			if len(siblings) == 0 {
				t.Fatal("missing voice sibling")
			}
			var sibling [32]byte
			if count, err := hex.Decode(sibling[:], []byte(siblings[0])); err != nil || count != len(sibling) {
				t.Fatalf("invalid voice sibling: %d, %v", count, err)
			}
			siblings = siblings[1:]
			if index%2 == 0 {
				node = commitmentParent(node, sibling)
			} else {
				node = commitmentParent(sibling, node)
			}
		}
		index, size = index/2, (size+1)/2
	}
	if len(siblings) != 0 {
		t.Fatal("extra voice siblings")
	}
	return countedCommitmentRoot(inclusion.Proof.Count, node)
}
