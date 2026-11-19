//go:build windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestDesktopLaunchStartupInfoHelper(t *testing.T) {
	report := os.Getenv("PAWTALK_DESKTOP_STARTUPINFO_REPORT")
	if report == "" {
		return
	}
	var startup windows.StartupInfo
	if err := windows.GetStartupInfo(&startup); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(struct {
		Flags uint32
		Args  []string
	}{startup.Flags, os.Args})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(report, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopFirstShowIsNotOverriddenByWindowsStartupInfo(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, settings := range []bool{false, true} {
		root := t.TempDir()
		report := filepath.Join(root, "startup.json")
		command := desktopLaunchCommand(root, "ru", settings)
		// Probe the actual child process's Win32 STARTUPINFO using the production
		// launcher settings, replacing only the executable with this test helper.
		command.Path = self
		command.Args = append([]string{self, "-test.run=^TestDesktopLaunchStartupInfoHelper$", "--"}, command.Args[1:]...)
		command.Env = append(os.Environ(), "PAWTALK_DESKTOP_STARTUPINFO_REPORT="+report)
		if err = command.Run(); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(report)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Flags uint32
			Args  []string
		}
		if err = json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		if result.Flags&windows.STARTF_USESHOWWINDOW != 0 {
			t.Fatal("Windows overrides the first GUI show", result.Flags)
		}
		mode := "--tray"
		if settings {
			mode = "--settings"
		}
		if result.Args[len(result.Args)-1] != mode {
			t.Fatal("incorrect launch mode", result.Args)
		}
	}
}

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

func TestDesktopPublicStatusRejectsSecretsAndInvalidDocuments(t *testing.T) {
	valid := `{"update":{"status":"available","version":"0.4.0","checkedAt":123},"language":"ru","autoManager":false,"serverVersion":"0.10.1","managerVersion":"0.3.0"}`
	if _, err := decodeDesktopStatus(strings.NewReader(valid)); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		strings.Replace(valid, `"language":"ru"`, `"password":"secret","language":"ru"`, 1),
		strings.Replace(valid, `"status":"available"`, `"password":"secret","status":"available"`, 1),
		strings.Replace(valid, `"status":"available"`, `"status":"secret"`, 1),
		strings.Replace(valid, `"language":"ru"`, `"language":"unknown"`, 1),
		strings.Replace(valid, `"version":"0.4.0"`, `"version":"secret"`, 1),
		valid + `{}`, valid + strings.Repeat(" ", 5000) + `{}`,
	} {
		if _, err := decodeDesktopStatus(strings.NewReader(invalid)); err == nil {
			t.Fatal("invalid public status accepted")
		}
	}
}
