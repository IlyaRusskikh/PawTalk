package main

import (
	"bytes"
	"encoding/json"
	"io"
)

// Artwork carries up to 12000 plaintext bytes, unlike small invitation keys.
func validateAvatarEnvelope(raw json.RawMessage) (memberInvitePackage, error) {
	var packet memberInvitePackage
	if len(raw) < 64 || len(raw) > 18000 {
		return packet, memberError(400, "INVALID_AVATAR")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&packet) != nil || packet.Version != 2 || !validHexID(packet.KeyID, 64) {
		return packet, memberError(400, "INVALID_AVATAR")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return packet, memberError(400, "INVALID_AVATAR")
	}
	if _, err := decodeFixed(packet.Nonce, 12); err != nil {
		return packet, memberError(400, "INVALID_AVATAR")
	}
	cipher, err := b64.Strict().DecodeString(packet.Ciphertext)
	if err != nil || len(cipher) < 17 || len(cipher) > 12016 || b64.EncodeToString(cipher) != packet.Ciphertext {
		return packet, memberError(400, "INVALID_AVATAR")
	}
	return packet, nil
}
