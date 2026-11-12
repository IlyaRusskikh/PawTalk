//go:build windows

package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestDesktopStatusReportsUnavailableForMissingService(t *testing.T) {
	if desktopStatus(t.TempDir())["state"] != "unavailable" {
		t.Fatal("missing service was presented as running")
	}
}
func TestDesktopControlNamesAreStableAndRootScoped(t *testing.T) {
	root := filepath.Join(t.TempDir(), "room")
	if desktopControlPipe(root) != desktopControlPipe(strings.ToUpper(root)) {
		t.Fatal("control identity changes with path casing")
	}
	if desktopControlPipe(root) == desktopControlPipe(root+"-other") {
		t.Fatal("different roots share a control pipe")
	}
	if !strings.HasPrefix(desktopCheckEvent(root), `Global\PawTalk.Manager.Check.`) {
		t.Fatal("invalid check event")
	}
}
func TestDesktopBrokerRejectsForeignPipeNames(t *testing.T) {
	if desktopBroker(`\\.\pipe\other-application`, strings.Repeat("a", 64), t.TempDir()) == nil {
		t.Fatal("foreign privileged pipe accepted")
	}
}
