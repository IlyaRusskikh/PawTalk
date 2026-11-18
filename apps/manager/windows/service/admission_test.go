//go:build windows

package main

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestInitialAdministratorClipboardBoundary(t *testing.T) {
	value := "pawtalk://192.0.2.10:18443/" + strings.Repeat("a", 64) + "#v=2&server=" + strings.Repeat("b", 32) + "&invite=" + strings.Repeat("c", 32) + "&token=" + base64.RawURLEncoding.EncodeToString(make([]byte, 32)) + "&setup=1"
	if !validInitialInvitation(value) {
		t.Fatal("valid API 2 initial link rejected")
	}
	for _, bad := range []string{strings.Replace(value, "pawtalk:", "https:", 1), value + "&setup=1", strings.Replace(value, "setup=1", "setup=0", 1), strings.Replace(value, ":18443/", ":443/", 1), value + "&password=synthetic", strings.Replace(value, "v=2", "v=1", 1)} {
		if validInitialInvitation(bad) {
			t.Fatal("malformed/legacy administrator invitation accepted")
		}
	}
}
