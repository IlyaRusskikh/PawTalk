package access

import (
	"bytes"
	"math"
	"strings"
	"testing"
)

// These fixed vectors are shared with protected-channel-settings-scope.test.mjs.
func TestChannelSettingsCommitmentV9Vectors(t *testing.T) {
	channel := strings.Repeat("9", 32)
	seed := [32]byte(bytes.Repeat([]byte{0xaa}, 32))
	var legacyTextAuthority string
	for _, vector := range []struct {
		name, kind, digest, authority string
		settings                      *ChannelSettings
	}{
		{"legacy nil", "text", "985ebf040f0bc5dd755ecc41b430d45819bc592de10906246399aff9b45dfc2f",
			"e81f7b290f1d4e4a543acd2f121fe57eece3880062919cd93e642ce1289a970c", nil},
		{"text", "text", "7ea730c7ca2a61f1c6f238d1ddb263bf7bdd3cf46f4a045012695d79827984f8",
			"0d72c664b1d2b3f579e5c5424b17da468eb5fb152dd03babbc1308b73dcc43e8",
			&ChannelSettings{Name: "Общий", Description: "🦊 rules", SlowmodeSeconds: 21600}},
		{"voice", "voice", "c81d2aae49933ccfa86440c3520564cda9bda63966933e7016eceb9996f6d92f",
			"6e9f7e767a924c7d0583fe8b855841a401bdda04d1cef7898594a1111aea21af",
			&ChannelSettings{Name: "Voice", VoiceCapacity: math.MaxUint32}},
	} {
		t.Run(vector.name, func(t *testing.T) {
			state := State{Channels: map[string]Channel{channel: {Kind: vector.kind, Settings: vector.settings}}}
			authority, _, err := state.channelOrderAuthority(channel, seed, "", ChannelSettingsProjectionVersion)
			if err != nil || authority.settingsDigest != vector.digest || authority.digest != vector.authority {
				t.Fatalf("v9 commitment = %+v, error = %v", authority, err)
			}
			legacy, _, err := state.channelOrderAuthority(channel, seed, "", VoiceRecipientProjectionVersion)
			if err != nil || legacy.settingsDigest != "" {
				t.Fatalf("v8 authority now includes settings: %+v, error = %v", legacy, err)
			}
			if vector.settings == nil {
				legacyTextAuthority = legacy.digest
			} else if vector.kind == "text" && legacy.digest != legacyTextAuthority {
				t.Fatalf("settings changed v8 text authority: %s != %s", legacy.digest, legacyTextAuthority)
			}
		})
	}
	large := ChannelSettings{Name: "Voice", Description: strings.Repeat("🦊", 18000), VoiceCapacity: 30}
	if got, err := channelSettingsDigest(&large); err != nil || got != "07fb48e9978dbaa2ea2c724d5b14a0fedfdef170e0669c1d1dfc4ba7f7142369" {
		t.Fatalf("large description digest = %s, error = %v", got, err)
	}
}
