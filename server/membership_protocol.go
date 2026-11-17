package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
)

const membershipProtocol = 2
const membershipChallengeSeconds = 60
const membershipSessionSeconds = 43200
const membershipReservationSeconds = 120
const membershipLinkSeconds = 600

var membershipCapabilities = []string{"membership-v1", "channels-v1", "device-links-v1", "invites-v1", "mandatory-e2ee-v1", "activity-v1", "attachment-removal-v1", "link-cancel-v1", "server-avatar-v1", "polls-v1", "system-poll-results-v1", "chat-events-v1", "server-events-v1"}

func signatureFrame(fields ...string) ([]byte, error) {
	var out bytes.Buffer
	for _, field := range fields {
		if out.Len()+4+len(field) > 65536 {
			return nil, errors.New("signature frame too large")
		}
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(len(field)))
		out.Write(length[:])
		out.WriteString(field)
	}
	return out.Bytes(), nil
}

func publicKeyID(key []byte) string {
	digest := sha256.Sum256(key)
	return hex.EncodeToString(digest[:])
}

type membershipProof struct {
	Binding     string `json:"binding"`
	ProfileKey  string `json:"profileKey"`
	DeviceKey   string `json:"deviceKey"`
	Certificate string `json:"certificate"`
	Challenge   string `json:"challenge"`
	Signature   string `json:"signature"`
}

func decodeFixed(value string, size int) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(decoded) != size || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return nil, errors.New("invalid encoded key or signature")
	}
	return decoded, nil
}

func (p membershipProof) keys() ([]byte, []byte, []byte, error) {
	identity, err := decodeFixed(p.ProfileKey, ed25519.PublicKeySize)
	if err != nil {
		return nil, nil, nil, err
	}
	device, err := decodeFixed(p.DeviceKey, ed25519.PublicKeySize)
	if err != nil {
		return nil, nil, nil, err
	}
	certificate, err := decodeFixed(p.Certificate, ed25519.SignatureSize)
	if err != nil {
		return nil, nil, nil, err
	}
	data, err := signatureFrame("pawtalk-device-v2", p.ProfileKey, p.DeviceKey)
	if err != nil || !ed25519.Verify(identity, data, certificate) {
		return nil, nil, nil, errors.New("invalid device certificate")
	}
	return identity, device, certificate, nil
}

func (p membershipProof) verify(serverID, method, uri string, nonce, body []byte) error {
	_, device, _, err := p.keys()
	if err != nil {
		return err
	}
	signature, err := decodeFixed(p.Signature, ed25519.SignatureSize)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(body)
	data, err := signatureFrame("pawtalk-request-v2", serverID, p.Binding, method, uri, p.Challenge, base64.RawURLEncoding.EncodeToString(nonce), hex.EncodeToString(hash[:]))
	if err != nil || !ed25519.Verify(device, data, signature) {
		return errors.New("invalid device proof")
	}
	return nil
}
