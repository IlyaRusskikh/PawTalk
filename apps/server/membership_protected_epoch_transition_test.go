package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"pawtalk/server/internal/access"
)

func TestProtectedEpochTransitionSignatureFrame(t *testing.T) {
	serverID := strings.Repeat("s", 32)
	signer := access.Principal{ProfileID: strings.Repeat("d", 64), DeviceID: strings.Repeat("e", 64)}
	live := access.EpochRecord{
		ChannelID: strings.Repeat("4", 32), Purpose: access.LiveEpoch, Generation: 10, Revision: 8,
		PolicyDigest: strings.Repeat("c", 64), PreviousDigest: strings.Repeat("b", 64), KeyID: strings.Repeat("f", 64),
		TaskID: strings.Repeat("1", 32), LeaseID: strings.Repeat("2", 32), PackagesDigest: strings.Repeat("9", 64),
	}
	archive := live
	archive.Purpose = access.ArchiveEpoch
	archive.ArchiveThrough = 10
	archive.ArchiveLinksDigest = strings.Repeat("7", 64)
	archive.ArchiveWrapKey = strings.Repeat("6", 64)
	transition := live
	transition.LiveTransitionDigest = "59447040745488caf8096c3d679d864f18bd0892045b16b543b386208b4d476c"
	archiveTransition := archive
	archiveTransition.ArchiveTransitionDigest = "7fa6e5babb8a9b84b1f9a2ad1a390d9b8ff54cb737a171543af911210a5a390f"

	for _, test := range []struct {
		name   string
		record access.EpochRecord
		digest string
	}{
		{"legacy live", live, "8000b29131d7cfa522f672e8700ab8d4233ab84d97874942fe078497391e74ab"},
		{"archive", archive, "dfd91dd122f83f643be6959787971a61228ddd99bdaa84948ea1b56fde8a02e7"},
		{"live transition", transition, "4fee084f260876a56ef8cb23a54438b9031ad884b2cad7b5b9e648887d97e2e5"},
		{"archive transition", archiveTransition, "2d332f8c7fc2a2d2f630641eaf0ee17f2afec2ca536efa0ddffdddd5ae95e128"},
	} {
		t.Run(test.name, func(t *testing.T) {
			frame, err := protectedEpochFrame(serverID, signer, test.record)
			digest := sha256.Sum256(frame)
			if err != nil || hex.EncodeToString(digest[:]) != test.digest {
				t.Fatalf("frame digest = %x, %v", digest, err)
			}
		})
	}

	mixed := archiveTransition
	mixed.LiveTransitionDigest = transition.LiveTransitionDigest
	missingWrap := archiveTransition
	missingWrap.ArchiveWrapKey = ""
	badDigest := archiveTransition
	badDigest.ArchiveTransitionDigest = strings.ToUpper(badDigest.ArchiveTransitionDigest)
	badPurpose := live
	badPurpose.ArchiveTransitionDigest = archiveTransition.ArchiveTransitionDigest
	for _, bad := range []access.EpochRecord{mixed, missingWrap, badDigest, badPurpose} {
		if _, err := protectedEpochFrame(serverID, signer, bad); !errors.Is(err, access.InvalidAction) {
			t.Fatalf("malformed transition accepted: %+v, %v", bad, err)
		}
	}

	key := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	frame, err := protectedEpochFrame(serverID, signer, transition)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(key, frame)
	altered := transition
	altered.LiveTransitionDigest = strings.Repeat("8", 64)
	for _, unstamped := range []access.EpochRecord{live, altered} {
		frame, err := protectedEpochFrame(serverID, signer, unstamped)
		if err != nil || ed25519.Verify(key.Public().(ed25519.PublicKey), frame, signature) {
			t.Fatalf("removed or changed transition remained signed: %v", err)
		}
	}
	frame, err = protectedEpochFrame(serverID, signer, archiveTransition)
	if err != nil {
		t.Fatal(err)
	}
	signature = ed25519.Sign(key, frame)
	altered = archiveTransition
	altered.ArchiveTransitionDigest = strings.Repeat("8", 64)
	for _, unstamped := range []access.EpochRecord{archive, altered} {
		frame, err := protectedEpochFrame(serverID, signer, unstamped)
		if err != nil || ed25519.Verify(key.Public().(ed25519.PublicKey), frame, signature) {
			t.Fatalf("removed or changed archive transition remained signed: %v", err)
		}
	}
}
