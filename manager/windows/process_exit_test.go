//go:build windows

package main

import (
	"bufio"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"
)

func TestProtectedProcessHelper(t *testing.T) {
	if os.Getenv("PAWTALK_PROTECTED_PROCESS_TEST") != "1" {
		return
	}
	sd, err := windows.SecurityDescriptorFromString("D:P")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	process, _ := windows.GetCurrentProcess()
	if err = windows.SetSecurityInfo(process, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	fmt.Println("protected")
	time.Sleep(time.Second)
}

func withoutDebugPrivilege(t *testing.T) {
	t.Helper()
	// Change only this test process's token and restore it. CI often starts with
	// debug privilege enabled, unlike a desktop UAC elevation from the tray.
	process, _ := windows.GetCurrentProcess()
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		t.Fatal(err)
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr("SeDebugPrivilege"), &luid); err != nil {
		t.Fatal(err)
	}
	next := windows.Tokenprivileges{PrivilegeCount: 1, Privileges: [1]windows.LUIDAndAttributes{{Luid: luid}}}
	var previous windows.Tokenprivileges
	var length uint32
	if err := windows.AdjustTokenPrivileges(token, false, &next, uint32(unsafe.Sizeof(previous)), &previous, &length); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.AdjustTokenPrivileges(token, false, &previous, 0, nil, nil); token.Close() })
}

func TestStopSCMServiceWithoutDebugPrivilege(t *testing.T) {
	root := os.Getenv("PAWTALK_SCM_NO_DEBUG_TEST_ROOT")
	if root == "" {
		return
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil || !strings.EqualFold(filepath.Dir(absolute), parent) || !strings.HasPrefix(filepath.Base(absolute), "PawTalk-CI-") {
		t.Fatal("not a disposable SCM fixture root")
	}
	marker, err := os.ReadFile(filepath.Join(absolute, ".pawtalk-manager-root"))
	if err != nil || string(marker) != "pawtalk-manager-v1" {
		t.Fatal("fixture ownership missing")
	}
	withoutDebugPrivilege(t)
	if err := control("stop-server", absolute); err != nil {
		t.Fatal("SCM stop depends on debug privilege", err)
	}
}

func TestWaitForServiceProcessWithoutDebugPrivilege(t *testing.T) {
	withoutDebugPrivilege(t)
	child := exec.Command(executable(), "-test.run=^TestProtectedProcessHelper$")
	child.Env = append(os.Environ(), "PAWTALK_PROTECTED_PROCESS_TEST=1")
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.Stderr = os.Stderr
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() || scanner.Text() != "protected" {
		t.Fatal("child did not restrict its process DACL")
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(child.Process.Pid))
	if handle != 0 {
		windows.CloseHandle(handle)
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatal("test did not reproduce LocalService process access denial", err)
	}
	observed, err := observeServiceProcess(uint32(child.Process.Pid))
	if err != nil || observed == nil {
		t.Fatal("access denial prevented SCM stop", err)
	}
	defer observed.close()
	if err = observed.wait(0); err == nil {
		t.Fatal("live inaccessible process mistaken for exited host")
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	if err = observed.wait(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}
