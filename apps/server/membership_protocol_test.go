package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"testing"
)

func TestMembershipSignatureFrameMatchesJS(t *testing.T) {
	data, err := signatureFrame("pawtalk", "Привет", "", "a\nb")
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(data) != "0000000770617774616c6b0000000cd09fd180d0b8d0b2d0b5d1820000000000000003610a62" {
		t.Fatalf("wrong framing: %x", data)
	}
	if _, err = signatureFrame(string(make([]byte, 65533))); err == nil {
		t.Fatal("oversize frame accepted")
	}
}

func TestMembershipProofBindsServerMethodPathBodyAndChallenge(t *testing.T) {
	root := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, 32))
	device := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{2}, 32))
	encode := base64.RawURLEncoding.EncodeToString
	p := membershipProof{ProfileKey: encode(root.Public().(ed25519.PublicKey)), DeviceKey: encode(device.Public().(ed25519.PublicKey)), Challenge: "test-challenge"}
	frame, _ := signatureFrame("pawtalk-device-v2", p.ProfileKey, p.DeviceKey)
	p.Certificate = encode(ed25519.Sign(root, frame))
	nonce := bytes.Repeat([]byte{3}, 32)
	body := []byte(`{"nickname":"Test"}`)
	hash := sha256.Sum256(body)
	frame, _ = signatureFrame("pawtalk-request-v2", "server", p.Binding, "POST", "/api/v2/session", p.Challenge, encode(nonce), hex.EncodeToString(hash[:]))
	p.Signature = encode(ed25519.Sign(device, frame))
	if err := p.verify("server", "POST", "/api/v2/session", nonce, body); err != nil {
		t.Fatal(err)
	}
	for _, v := range [][3]string{{"other", "POST", "/api/v2/session"}, {"server", "DELETE", "/api/v2/session"}, {"server", "POST", "/api/v2/session?x=1"}} {
		if p.verify(v[0], v[1], v[2], nonce, body) == nil {
			t.Fatal("proof accepted for different operation")
		}
	}
	if p.verify("server", "POST", "/api/v2/session", nonce, []byte(`{"nickname":"Changed"}`)) == nil {
		t.Fatal("body substitution accepted")
	}
	p.Binding = "tls-sha256:another-server"
	if p.verify("server", "POST", "/api/v2/session", nonce, body) == nil {
		t.Fatal("transport substitution accepted")
	}
	p.Binding = ""
	p.Challenge = "another"
	if p.verify("server", "POST", "/api/v2/session", nonce, body) == nil {
		t.Fatal("challenge substitution accepted")
	}
}
