package main

import (
	"cmp"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strconv"
	"time"

	"pawtalk/server/internal/access"
)

const protectedVoiceKeyTTL = time.Minute

type protectedVoiceKeyBasis struct {
	ServerID     string `json:"serverId"`
	ChannelID    string `json:"channelId"`
	Binding      string `json:"binding"`
	EpochID      string `json:"epochId"`
	Revision     int64  `json:"revision"`
	PolicyDigest string `json:"policyDigest"`
	RosterDigest string `json:"rosterDigest"`
	ExpiresAt    int64  `json:"expiresAt"`
}

type protectedVoiceKeyOffer struct {
	Basis      protectedVoiceKeyBasis `json:"basis"`
	Commitment string                 `json:"commitment"`
	Signature  []byte                 `json:"signature"`
	Packages   map[string][]byte      `json:"packages"` // by recipient session ID
}

func protectedVoiceRosterDigest(roster []access.VoiceKeyRecipient) (string, error) {
	if len(roster) == 0 || len(roster) > 8192 {
		return "", access.ErrEpochRecipients
	}
	ordered := slices.Clone(roster)
	slices.SortFunc(ordered, func(a, b access.VoiceKeyRecipient) int { return cmp.Compare(a.SessionID, b.SessionID) })
	digest := sha256.New()
	header, _ := signatureFrame("pawtalk-protected-voice-roster-v1", strconv.Itoa(len(ordered)))
	digest.Write(header)
	sessions, profiles, devices := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, recipient := range ordered {
		if !validHexID(recipient.SessionID, 32) || !validHexID(recipient.ProfileID, 64) ||
			!validHexID(recipient.DeviceID, 64) || !validHexID(recipient.PublicKey, 64) ||
			sessions[recipient.SessionID] || profiles[recipient.ProfileID] || devices[recipient.DeviceID] {
			return "", access.ErrEpochRecipients
		}
		sessions[recipient.SessionID], profiles[recipient.ProfileID], devices[recipient.DeviceID] = true, true, true
		step, _ := signatureFrame(recipient.SessionID, recipient.ProfileID, recipient.DeviceID, recipient.PublicKey)
		digest.Write(step)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func (b protectedVoiceKeyBasis) signatureFields() []string {
	return []string{b.ServerID, b.ChannelID, b.Binding, b.EpochID, strconv.FormatInt(b.Revision, 10),
		b.PolicyDigest, b.RosterDigest, strconv.FormatInt(b.ExpiresAt, 10)}
}

func protectedVoiceKeyFrame(b protectedVoiceKeyBasis, author access.VoiceKeyRecipient, commitment string) ([]byte, error) {
	fields := append([]string{"pawtalk-protected-voice-key-v1"}, b.signatureFields()...)
	return signatureFrame(append(fields, author.SessionID, author.ProfileID, author.DeviceID, commitment)...)
}

// expected and roster must be read under the same transaction as the voice
// slot, signed policy and session checks. A proposal cannot set its deadline.
func verifyProtectedVoiceKeyOffer(ctx context.Context, query access.SessionQuery, now time.Time, expected protectedVoiceKeyBasis,
	roster []access.VoiceKeyRecipient, author access.VoiceKeyRecipient, offer protectedVoiceKeyOffer) error {
	if offer.Basis != expected || !validHexID(expected.ServerID, 32) || !validHexID(expected.ChannelID, 32) ||
		!validHexID(expected.Binding, 64) || !validHexID(expected.EpochID, 32) || expected.Revision <= 0 ||
		!validHexID(expected.PolicyDigest, 64) || expected.ExpiresAt <= now.UnixMilli() ||
		expected.ExpiresAt > now.Add(protectedVoiceKeyTTL).UnixMilli() ||
		!validHexID(offer.Commitment, 64) {
		return access.ErrVoiceGrantChanged
	}
	digest, err := protectedVoiceRosterDigest(roster)
	if err != nil || digest != expected.RosterDigest || !slices.Contains(roster, author) || len(offer.Packages) != len(roster) {
		return access.ErrEpochRecipients
	}
	for _, recipient := range roster {
		if len(offer.Packages[recipient.SessionID]) != access.EpochPackageSize {
			return access.ErrEpochRecipients
		}
	}
	server, key, err := protectedSigner(ctx, query, author.DeviceID)
	if err != nil {
		return err
	}
	frame, err := protectedVoiceKeyFrame(expected, author, offer.Commitment)
	if err != nil {
		return err
	}
	if server != expected.ServerID || !ed25519.Verify(key, frame, offer.Signature) {
		return memberError(403, "INVALID_VOICE_KEY_SIGNATURE")
	}
	return nil
}
