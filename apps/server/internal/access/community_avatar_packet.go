package access

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"strconv"
)

const MaxCommunityAvatarBytes = 12_000

type CommunityAvatarContext struct {
	ServerID   string `json:"serverId"`
	Revision   int64  `json:"revision"`
	Operation  string `json:"operationId"`
	PolicyHead string `json:"policyHead"`
	ProfileID  string `json:"profileId"`
	DeviceID   string `json:"deviceId"`
	Scope      string `json:"scope,omitempty"`
}

type CommunityAvatarPacket struct {
	Nonce         []byte `json:"nonce"`
	Ciphertext    []byte `json:"ciphertext"`
	KeyCommitment string `json:"keyCommitment"`
	Signature     []byte `json:"signature"`
}

func (packet CommunityAvatarPacket) Verify(binding CommunityAvatarContext, signer string) error {
	if !validRotationID(binding.ServerID) || !validRotationID(binding.Operation) || !isDigest(binding.PolicyHead) ||
		!isDigest(binding.ProfileID) || !signingKeyMatches(binding.DeviceID, signer) ||
		binding.Revision < 2 || binding.Revision > 1<<53-1 || !isDigest(packet.KeyCommitment) ||
		len(packet.Nonce) != 12 || len(packet.Ciphertext) < 17 || len(packet.Ciphertext) > MaxCommunityAvatarBytes+16 ||
		len(packet.Signature) != ed25519.SignatureSize {
		return InvalidAction
	}
	fields := []string{"pawtalk-community-avatar-signature-v1", binding.ServerID, strconv.FormatInt(binding.Revision, 10),
		binding.Operation, binding.PolicyHead, binding.ProfileID, binding.DeviceID}
	if binding.Scope != "" {
		if binding.Scope != "profile" {
			return InvalidAction
		}
		fields = append(fields, binding.Scope)
	}
	frame, err := SignatureFrame(append(fields, packet.KeyCommitment,
		base64.RawURLEncoding.EncodeToString(packet.Nonce), hexHash(packet.Ciphertext))...)
	if err != nil {
		return err
	}
	key, err := hex.DecodeString(signer)
	if err != nil || !ed25519.Verify(key, frame, packet.Signature) {
		return ChannelRestricted
	}
	return nil
}
