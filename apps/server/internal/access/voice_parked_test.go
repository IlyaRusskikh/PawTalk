package access

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestParkedVoiceReplacementRequiresConfirmedSameDeviceRetirement(t *testing.T) {
	ctx := context.Background()
	db, store := openTestPolicy(t, filepath.ToSlash(filepath.Join(t.TempDir(), "parked-voice.sqlite")))
	state, _, original, other := profileLinkFixture(t)
	other.ProfileID = original.ProfileID
	otherKey := state.PolicyDevices[other.DeviceID]
	otherKey.ProfileID = original.ProfileID
	state.PolicyDevices[other.DeviceID] = otherKey
	delete(state.KeyRecipients, other.DeviceID)
	state.Roles[Everyone] = Role{Grants: []string{ChannelView, "voice.connect"}}
	channel := strings.Repeat("1", 32)
	state.Channels[channel] = Channel{Kind: "voice", NextPosition: 1}
	state.VoiceRestrictions = map[string]map[string]VoiceRestriction{channel: {original.ProfileID: {Deafened: true}}}
	if err := store.Initialize(ctx, state); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	const now, until = 1000, 45000
	oldSession, freshSession := strings.Repeat("2", 32), strings.Repeat("3", 32)
	oldDigest, freshDigest := strings.Repeat("4", 64), strings.Repeat("5", 64)
	if _, err := ReserveRuntimeVoice(ctx, tx, original, oldSession, channel, now, until, until); err != nil {
		t.Fatal(err)
	}
	if err := RecordVoiceGrant(ctx, tx, channel, original.ProfileID, oldSession, oldDigest, 0); err != nil {
		t.Fatal(err)
	}
	assertOccupied := func(principal Principal) {
		t.Helper()
		if _, err := ReserveRuntimeVoice(ctx, tx, principal, freshSession, channel, now, until, 0); !errors.Is(err, ErrVoiceOccupied) {
			t.Fatalf("expected occupied for %s, got %v", principal.DeviceID, err)
		}
	}
	assertOccupied(original)
	assertOccupied(other)
	if _, err := ReleaseVoice(ctx, tx, original, oldSession); err != nil {
		t.Fatal(err)
	}
	assertOccupied(original)
	if err := ReconcileVoice(ctx, tx, channel, original.ProfileID, now, func(session string, admission *VoiceAdmission) error {
		if session != oldSession || admission != nil {
			t.Fatalf("expected retired media removal, got %s %+v", session, admission)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	assertOccupied(other)
	if _, err := ReserveVoice(ctx, tx, original, freshSession, channel, now, until, 0); !errors.Is(err, ErrVoiceOccupied) {
		t.Fatalf("legacy slot reservation changed: %v", err)
	}
	if _, err := ReserveRuntimeVoice(ctx, tx, original, freshSession, channel, now, until, until); err != nil {
		t.Fatal(err)
	}
	if err := AuthorizeDeafenedVoiceGrant(ctx, tx, original, freshSession, channel, now); err != nil {
		t.Fatal(err)
	}
	if err := RecordVoiceGrant(ctx, tx, channel, original.ProfileID, freshSession, freshDigest, 0); err != nil {
		t.Fatal(err)
	}
	if err := ValidateVoiceSignal(ctx, tx, original, channel, oldSession, oldDigest, false, false, now); !errors.Is(err, ErrVoiceSlotLost) {
		t.Fatalf("retired session could signal after parked replacement: %v", err)
	}
	if err := ValidateVoiceSignal(ctx, tx, original, channel, freshSession, oldDigest, false, false, now); !errors.Is(err, ErrVoiceGrantChanged) {
		t.Fatalf("retired grant digest matched the replacement session: %v", err)
	}
	if err := ValidateVoiceSignal(ctx, tx, original, channel, freshSession, freshDigest, false, false, now); err != nil {
		t.Fatal(err)
	}
}
