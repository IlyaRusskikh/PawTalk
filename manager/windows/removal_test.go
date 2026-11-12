//go:build windows

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

func TestStopWaitsForStartupAndConcurrentSCMTransitions(t *testing.T) {
	states := []svc.Status{{State: svc.StartPending}, {State: svc.Running, Accepts: svc.AcceptStop}, {State: svc.Running, Accepts: svc.AcceptStop}, {State: svc.StopPending}, {State: svc.Stopped}}
	index, requests := 0, 0
	query := func() (svc.Status, error) { status := states[index]; index++; return status, nil }
	stop := func() error {
		requests++
		if requests == 1 {
			return windows.ERROR_SERVICE_CANNOT_ACCEPT_CTRL
		}
		return nil
	}
	if err := waitServiceStopped(query, stop, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if index != len(states) || requests != 2 {
		t.Fatal("startup or stop-pending mistaken for completed stop", index, requests)
	}
	if err := waitServiceStopped(func() (svc.Status, error) { return svc.Status{State: svc.StartPending}, nil }, func() error { t.Fatal("control sent during startup"); return nil }, 0); err == nil {
		t.Fatal("hung startup never timed out")
	}
	if err := waitServiceStopped(func() (svc.Status, error) { return svc.Status{State: svc.Running, Accepts: svc.AcceptStop}, nil }, func() error { return windows.ERROR_ACCESS_DENIED }, time.Second); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatal("permission failure hidden", err)
	}
}

func TestServiceDeletionWaitsForSCMToReleaseItsName(t *testing.T) {
	sequence := []error{nil, windows.ERROR_SERVICE_MARKED_FOR_DELETE, windows.ERROR_SERVICE_DOES_NOT_EXIST}
	index := 0
	if err := waitServiceGone(func() error { result := sequence[index]; index++; return result }, time.Second); err != nil {
		t.Fatal(err)
	}
	if index != len(sequence) {
		t.Fatal("pending deletion was mistaken for deletion completion")
	}
	if err := waitServiceGone(func() error { return windows.ERROR_ACCESS_DENIED }, time.Second); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatal("permission failure hidden", err)
	}
	if err := waitServiceGone(func() error { return windows.ERROR_SERVICE_MARKED_FOR_DELETE }, 0); err == nil {
		t.Fatal("pending deletion never timed out")
	}
}

func TestPythonUsesConsoleHostEvenFromGUI(t *testing.T) {
	command := python(context.Background(), "fixture.py", "--self-test")
	expected := "PAWTALK_MANAGER_HOST=" + filepath.Join(base(), "pawtalkctl.exe")
	var actual string
	for _, entry := range command.Env {
		if strings.HasPrefix(entry, "PAWTALK_MANAGER_HOST=") {
			actual = entry
		}
	}
	if actual != expected {
		t.Fatalf("Python must call console protocol host: %q", actual)
	}
	if command.SysProcAttr == nil || !command.SysProcAttr.HideWindow {
		t.Fatal("embedded Python can open a second installer console")
	}
}

func TestCredentialDPAPI(t *testing.T) {
	plain := []byte(`{"password":"fixture-password","binding":"fixture"}`)
	sealed, err := credentialBytes(plain, false)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, plain) || bytes.Contains(sealed, []byte("fixture-password")) {
		t.Fatal("password stored in plaintext")
	}
	opened, err := credentialBytes(sealed, true)
	if err != nil || !bytes.Equal(opened, plain) {
		t.Fatal("DPAPI round trip failed", err)
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := credentialBytes(sealed, true); err == nil {
		t.Fatal("tampered credential accepted")
	}
}

func TestPurgeBoundaryAndOwnership(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "room")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := validateDataRemoval(root, parent); err == nil {
		t.Fatal("unowned directory accepted")
	}
	if err := os.WriteFile(filepath.Join(root, ".pawtalk-manager-root"), []byte("pawtalk-manager-v1"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateDataRemoval(root, parent); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{parent, filepath.Join(parent, ".."), filepath.Join(root, "nested")} {
		if err := validateDataRemoval(path, parent); err == nil {
			t.Fatal("unsafe recursive target accepted", path)
		}
	}
	if err := prepareInstall(root); err == nil {
		t.Fatal("installer accepted a non-ProgramData path")
	}
	if err := retireLegacyInstall(root); err == nil {
		t.Fatal("legacy cleanup accepted an unrelated path")
	}
	external := filepath.Join(parent, "unrelated")
	if err := os.Mkdir(external, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(external, "keep.txt"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(root, "linked")
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", junction, external).CombinedOutput(); err != nil {
		t.Fatalf("junction fixture: %v %s", err, output)
	}
	if err := removeOwnedData(root, parent); err == nil {
		t.Fatal("recursive removal accepted a junction")
	}
	if err := os.Remove(junction); err != nil {
		t.Fatal(err)
	}
	if err := removeOwnedData(root, parent); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("owned data was not removed")
	}
	if data, err := os.ReadFile(filepath.Join(external, "keep.txt")); err != nil || string(data) != "keep" {
		t.Fatal("unrelated data changed")
	}
}

func TestWindowsBootstrapRoutes(t *testing.T) {
	for _, args := range [][]string{{"install"}, {"--lang", "ru", "install"}, {"invitation", "--url"}, {"--lang", "en", "invitation", "--reset-password", "--yes"}, {"settings"}, {"settings", "--apply"}, {"desktop", "snapshot"}, {"periodic"}, {"--lang", "en", "health"}, {"run-server"}} {
		if !bootstrapCommand(args) {
			t.Fatal("Windows UX used a downloaded older Manager", args)
		}
	}
	for _, args := range [][]string{{"manager", "now"}, {"--lang"}} {
		if bootstrapCommand(args) {
			t.Fatal("maintenance bypassed selected signed Manager", args)
		}
	}
}
