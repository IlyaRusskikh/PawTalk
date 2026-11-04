package main

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"testing"
)

func TestRoomCertificateCoversInvitationAddresses(t *testing.T) {
	addresses := []string{"192.168.0.13", "203.0.113.10", "2001:db8::1", "192.168.0.13"}
	certificate, pin, err := roomCertificate(addresses)
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range append(addresses, "127.0.0.1", "::1") {
		if err := certificate.Leaf.VerifyHostname(address); err != nil {
			t.Fatalf("certificate does not cover invitation %s: %v", address, err)
		}
	}
	if err := certificate.Leaf.VerifyHostname("192.168.0.14"); err == nil {
		t.Fatal("certificate covers an unrelated host")
	}
	roots := x509.NewCertPool()
	roots.AddCert(certificate.Leaf)
	if _, err := certificate.Leaf.Verify(x509.VerifyOptions{DNSName: "192.168.0.13", Roots: roots}); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(certificate.Certificate[0])
	if pin != hex.EncodeToString(digest[:]) {
		t.Fatal("invitation pin does not match certificate")
	}
	if len(certificate.Leaf.IPAddresses) != 5 {
		t.Fatal("IP SANs were not deduplicated")
	}
}

func TestRoomCertificateRejectsInvalidAddressesAndRotates(t *testing.T) {
	if _, _, err := roomCertificate([]string{"example.com"}); err == nil {
		t.Fatal("accepted a non-IP room address")
	}
	if _, _, err := roomCertificate(make([]string, 65)); err == nil {
		t.Fatal("accepted excessive addresses")
	}
	_, first, err := roomCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	_, second, err := roomCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("certificate was reused across rooms")
	}
}
