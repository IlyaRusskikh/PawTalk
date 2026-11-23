package access

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestChannelACLCommitmentV10Vector(t *testing.T) {
	channel, category := strings.Repeat("9", 32), strings.Repeat("8", 32)
	ownerID, editorID, personalID := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64)
	ownerKey := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(1))
	editorKey := scopeAuthorityTestPublicKey(scopeAuthorityTestKey(2))
	deviceID := func(key string) string { return hexHash(parseScopeAuthorityKey(key)) }
	editorDevice := deviceID(editorKey)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: ownerID, Order: []string{"editor"}, Roles: map[string]Role{
				Everyone: {}, "editor": {Grants: []string{ChannelView, channelACLPermission}},
			}},
			Members: map[string]Subject{
				ownerID: {ID: ownerID, Active: true}, editorID: {ID: editorID, Active: true, Roles: []string{"editor"}},
				personalID: {ID: personalID, Active: true},
			},
		},
		Channels: map[string]Channel{channel: {Kind: "text", CategoryID: category, Synchronized: true}},
		Categories: map[string]ACL{category: {
			Roles:    map[string]Overwrite{"editor": {Allow: []string{ChannelView, "voice.speak"}, Deny: []string{"message.send"}}},
			Profiles: map[string]Overwrite{personalID: {Deny: []string{ChannelView}}},
		}},
		PolicyDevices: map[string]PolicyDevice{
			deviceID(ownerKey): {ProfileID: ownerID, PublicKey: ownerKey}, editorDevice: {ProfileID: editorID, PublicKey: editorKey},
		},
	}
	seed := [32]byte(bytes.Repeat([]byte{0xaa}, 32))
	acl, witness, err := state.channelACLAuthority(channel, state.scope(state.Channels[channel]), seed, editorDevice)
	if err != nil || witness.proof.Count != 2 || witness.editor.actor != (Principal{ProfileID: editorID, DeviceID: editorDevice}) {
		t.Fatalf("ACL editor not included: %+v, %v", witness, err)
	}
	wire, err := json.Marshal(acl.rules)
	if err != nil || string(wire) != `{"editor":{"Allow":["channel.view"],"Deny":["message.send"]}}` {
		t.Fatalf("unexpected scoped rules: %s, %v", wire, err)
	}
	authority, order, err := state.channelOrderAuthority(channel, seed, deviceID(ownerKey), ChannelACLProjectionVersion)
	if err != nil || order.ACLRoot != acl.root || order.Editors.Count != 1 {
		t.Fatalf("expected distinct order proof: %+v, %v", order, err)
	}
	if _, _, err := state.channelOrderAuthority(channel, seed, editorDevice, ChannelACLProjectionVersion); !errors.Is(err, ChannelRestricted) {
		t.Fatalf("ACL edit ability granted order edit proof: %v", err)
	}
	legacy, previous, err := state.channelOrderAuthority(channel, seed, deviceID(ownerKey), ChannelSettingsProjectionVersion)
	if err != nil || previous.ACLRoot != "" || legacy.settingsDigest != authority.settingsDigest || legacy.editorsRoot != authority.editorsRoot {
		t.Fatalf("v9 order/settings changed: %+v, %v", legacy, err)
	}
	root, err := state.textProjectionRoot(strings.Repeat("aa", 32), ChannelACLProjectionVersion)
	if err != nil {
		t.Fatal(err)
	}
	for _, vector := range []struct{ name, got, want string }{
		{"acl root", acl.root, "fdede65ba9106f84afd8d907d83aff1adf3ad4c02e693361978cf43ac65fdeb6"},
		{"role rules salt", acl.rulesSalt, "b57995b89738c53d82e60eb883de87135b20717fdbd12f0cd578d8480f91870b"},
		{"resource v3", authority.digest, "67a79b94845651adb2cefe13bf7b737eb1f1aba709c56fe36aeeb15a9942984e"},
		{"policy tree", root, "d4fe65c8854eb2e2cdaae16f7114ad05035cfe61bed295bbe596b27dd688d821"},
		{"order editors root", authority.editorsRoot, "dea04c172fe3e43ecc4a43d0097304a5d89185195505300df43aae40dba55705"},
		{"ACL editor salt", hex.EncodeToString(witness.editor.salt[:]), "cf6debd9f36a7b78bb47aee26859b0e76d257abcc056fbc9a88e050310df18b4"},
	} {
		if vector.got != vector.want {
			t.Errorf("%s = %s, want %s", vector.name, vector.got, vector.want)
		}
	}
	if proof := witness.proof; proof.Index != 1 || len(proof.Siblings) != 1 ||
		proof.Siblings[0] != "d03f121d3dbd1c7976e12d73dab8c7256c6356db17c3611ac0a7ec69f124de3e" {
		t.Fatalf("unexpected ACL witness: %+v", proof)
	}
}
