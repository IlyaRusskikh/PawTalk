//go:build windows

package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

func TestTrayHelper(t *testing.T) {
	if root := os.Getenv("PAWTALK_TRAY_TEST_ROOT"); root != "" {
		if err := runTray(root, os.Getenv("PAWTALK_TRAY_TEST_LANG")); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
}

func TestNativeClipboardHelper(t *testing.T) {
	// The Electron harness snapshots/restores the real clipboard around this
	// subprocess. Ordinary go test must never replace the user's clipboard.
	if os.Getenv("PAWTALK_NATIVE_CLIPBOARD_HELPER") != "1" {
		return
	}
	if err := putClipboard("PawTalk native clipboard fixture"); err != nil {
		t.Fatal(err)
	}
}

func TestNativeTrayLifecycle(t *testing.T) {
	// Actual notification-area API, window messages, mutex and process cleanup.
	// Service start/stop needs the separate Administrator/SCM integration suite.
	icon, err := os.ReadFile(filepath.Join("..", "..", "assets", "server.ico"))
	if err != nil {
		t.Fatal(err)
	}
	iconPath := filepath.Join(base(), "server.ico")
	if err := os.WriteFile(iconPath, icon, 0600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(iconPath)
	for _, lang := range []string{"ru", "en"} {
		t.Run(lang, func(t *testing.T) {
			root := t.TempDir()
			hash := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(root))))
			name := fmt.Sprintf("PawTalk.Server.Tray.%x", hash[:8])
			child := exec.Command(executable(), "-test.run=^TestTrayHelper$")
			child.Env = append(os.Environ(), "PAWTALK_TRAY_TEST_ROOT="+root, "PAWTALK_TRAY_TEST_LANG="+lang)
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			defer child.Process.Kill()
			var window uintptr
			for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
				window = trayCall("FindWindowW", wide(name), 0)
				if window != 0 {
					var title [256]uint16
					trayCall("GetWindowTextW", window, unsafe.Pointer(&title[0]), uintptr(len(title)))
					if strings.Contains(windows.UTF16ToString(title[:]), trayText(lang).Unavailable) {
						break
					}
				}
				window = 0
			}
			if window == 0 {
				t.Fatal("native tray window/status not created")
			}
			duplicate := exec.Command(executable(), "-test.run=^TestTrayHelper$")
			duplicate.Env = child.Env
			doneDuplicate := make(chan error, 1)
			go func() { doneDuplicate <- duplicate.Run() }()
			select {
			case err := <-doneDuplicate:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				_ = duplicate.Process.Kill()
				t.Fatal("duplicate tray was not suppressed")
			}
			// Both the menu and installer-maintenance close leave service control
			// untouched, and release the executable for replacement.
			if lang == "ru" {
				trayCall("PostMessageW", window, 0x111, 3, 0)
			} else if err := closeTray(root); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- child.Wait() }()
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("tray Exit command did not finish")
			}
			if trayCall("FindWindowW", wide(name), 0) != 0 {
				t.Fatal("tray window leaked")
			}
		})
	}
}

func TestTrayStatusLocalization(t *testing.T) {
	for _, lang := range []string{"ru", "en"} {
		labels := trayText(lang)
		if trayStatus(svc.Running, nil, labels) != labels.Running || trayStatus(svc.Stopped, nil, labels) != labels.Stopped || trayStatus(svc.StartPending, nil, labels) != labels.Pending {
			t.Fatal("untranslated service state")
		}
	}
}
