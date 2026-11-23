package access

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTextNewcomerAdmissionResolverVectors(t *testing.T) {
	channel := strings.Repeat("9", 32)
	category := strings.Repeat("8", 32)
	state := State{
		RoleSnapshot: RoleSnapshot{
			Policy: Policy{Owner: "newcomer", Roles: map[string]Role{
				Everyone: {Grants: []string{ChannelView, "message.send"}},
				"staff":  {Grants: []string{"history.full"}},
			}},
			Members: map[string]Subject{
				"newcomer": {ID: "newcomer", Active: true, Roles: []string{"staff"}},
			},
		},
		Categories: map[string]ACL{category: {
			Roles: map[string]Overwrite{Everyone: {Allow: []string{"history.full"}, Deny: []string{"message.send"}}},
		}},
		Channels: make(map[string]Channel),
	}
	var seed [32]byte
	for i := range seed {
		seed[i] = 0xaa
	}
	for _, test := range []struct {
		name                   string
		channel                Channel
		visible, archive, send bool
		digest                 string
	}{
		{"ordinary local", Channel{Kind: "text", ACL: ACL{Profiles: map[string]Overwrite{
			"newcomer": {Allow: []string{"history.full"}, Deny: []string{"message.send"}},
		}}}, true, false, true, "fe173d1d2d3b550bb926ce241c3ffe1f3da9d19d93e22d4169f52126ac9ef4f0"},
		{"hidden local", Channel{Kind: "text", ACL: ACL{Roles: map[string]Overwrite{
			Everyone: {Allow: []string{"history.full"}, Deny: []string{ChannelView}},
		}}}, false, false, false, "173d27ae16774754e9abdaf0dd5833c462ca27731ad8af0cad19518fac379321"},
		{"synchronized full", Channel{Kind: "text", CategoryID: category, Synchronized: true},
			true, true, false, "4ae577396d6dcc29fde3d4583593e0bf1f04a456a4172f0554b70cd04e35dd83"},
	} {
		t.Run(test.name, func(t *testing.T) {
			state.Channels[channel] = test.channel
			digest, opening, err := state.textNewcomerAdmissionCommitment(channel, seed)
			if err != nil || digest != test.digest || opening != (TextNewcomerAdmissionOpening{
				Salt:    "a13eb5a00f83ee9dfb160df0ca359334409e0301e55ec83766b3d3b892bef882",
				Visible: test.visible, Archive: test.archive, CanSend: test.send,
			}) {
				t.Fatalf("newcomer commitment = %s, %+v, %v", digest, opening, err)
			}
		})
	}
	state.Channels[channel] = Channel{Kind: "voice"}
	if _, _, err := state.textNewcomerAdmissionCommitment(channel, seed); err != ChannelRestricted {
		t.Fatalf("non-text newcomer proof: %v", err)
	}
}

func TestTextNewcomerAdmissionProjectionPreservesV16(t *testing.T) {
	channel := strings.Repeat("9", 32)
	state := State{
		RoleSnapshot: RoleSnapshot{Policy: Policy{Roles: map[string]Role{Everyone: {Grants: []string{ChannelView, "message.send"}}}}},
		Channels:     map[string]Channel{channel: {Kind: "text", NextPosition: 1}},
	}
	var seed [32]byte
	for i := range seed {
		seed[i] = 0xaa
	}
	legacy, err := state.textRecipientCommitment(channel, seed, "", TextRoleViewDenyProjectionVersion, 0)
	if err != nil {
		t.Fatal(err)
	}
	current, err := state.textRecipientCommitment(channel, seed, "", TextNewcomerAdmissionProjectionVersion, 0)
	if err != nil || current.rotation == nil || current.rotation.Newcomer != "fe173d1d2d3b550bb926ce241c3ffe1f3da9d19d93e22d4169f52126ac9ef4f0" {
		t.Fatalf("missing v17 newcomer projection: %+v, %v", current, err)
	}
	want := *current.rotation
	want.Newcomer = ""
	if *legacy.rotation != want || legacy.root != "6304f69f3a1318579fe2244e126d6ab782a612243b8296fd997dda28f78d0d34" ||
		current.root != "847042721449209b4201ad6288cd056dfc15853b99ecd6fb7d3c53b14054494c" {
		t.Fatalf("v16/v17 text commitments changed: %s / %s", legacy.root, current.root)
	}
	raw, err := json.Marshal(legacy.rotation)
	if err != nil || strings.Contains(string(raw), "newcomer") {
		t.Fatalf("newcomer field leaked into v16: %s, %v", raw, err)
	}
	unknown := strings.Repeat("4", 64)
	acl := ACL{Profiles: map[string]Overwrite{unknown: {Deny: []string{ChannelView}}}}
	if state.validACL(acl, "text") {
		t.Fatal("a nonexistent profile accepted a personal overwrite")
	}
	state.Members = map[string]Subject{unknown: {ID: unknown, Active: false}}
	if !state.validACL(acl, "text") {
		t.Fatal("fixture must allow personal overwrites for a known inactive profile")
	}
}
