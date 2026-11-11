//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"unsafe"
)

func TestNativeDescriptorLimitsLocalServiceToDataWrites(t *testing.T) {
	for _, rights := range []string{"GRGX", "0x1301bf"} {
		sd, e := descriptor(rights)
		if e != nil {
			t.Fatal(e)
		}
		owner, _, e := sd.Owner()
		if e != nil || owner.String() != "S-1-5-32-544" {
			t.Fatal("Administrator ownership required")
		}
		acl, _, e := sd.DACL()
		if e != nil {
			t.Fatal(e)
		}
		var ace *windows.ACCESS_ALLOWED_ACE
		if e = windows.GetAce(acl, 2, &ace); e != nil {
			t.Fatal(e)
		}
		if (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String() != "S-1-5-19" {
			t.Fatal("LocalService SID required")
		}
		if uint32(ace.Mask)&(windows.WRITE_DAC|windows.WRITE_OWNER) != 0 {
			t.Fatal("Server can change file security")
		}
		if rights == "GRGX" && uint32(ace.Mask)&(windows.GENERIC_WRITE|windows.GENERIC_ALL|windows.FILE_WRITE_DATA|windows.FILE_APPEND_DATA) != 0 {
			t.Fatal("Server can modify code/config")
		}
		if rights != "GRGX" && uint32(ace.Mask)&windows.FILE_WRITE_DATA == 0 {
			t.Fatal("Server cannot write its data")
		}
		if windows.GetAce(acl, 3, &ace) == nil {
			t.Fatal("Private root grants an extra identity access")
		}
	}
}

func TestProgramCodeCanLaunchElevationWithoutUserWriteAccess(t *testing.T) {
	sd, e := descriptor("GRGX", true)
	if e != nil {
		t.Fatal(e)
	}
	acl, _, e := sd.DACL()
	if e != nil {
		t.Fatal(e)
	}
	var ace *windows.ACCESS_ALLOWED_ACE
	if e = windows.GetAce(acl, 3, &ace); e != nil {
		t.Fatal(e)
	}
	if (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String() != "S-1-5-32-545" {
		t.Fatal("Users must be able to launch the elevation helper")
	}
	if uint32(ace.Mask)&(windows.GENERIC_WRITE|windows.GENERIC_ALL|windows.FILE_WRITE_DATA|windows.WRITE_DAC|windows.WRITE_OWNER) != 0 {
		t.Fatal("Users can modify privileged program code")
	}
}

func TestProtectRefusesUnownedNonemptyRoot(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "existing.txt")
	if e := os.WriteFile(file, []byte("preserve"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := protectRoot(directory); e == nil {
		t.Fatal("adopted an unowned nonempty directory")
	}
	data, e := os.ReadFile(file)
	if e != nil || string(data) != "preserve" {
		t.Fatal("existing content changed")
	}
	if _, e = os.Stat(filepath.Join(directory, ".pawtalk-manager-root")); !os.IsNotExist(e) {
		t.Fatal("ownership was recorded despite refusal")
	}
}

func TestProtectRefusesJunctionWithoutTouchingTarget(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "target")
	if e := os.Mkdir(target, 0700); e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(target, "existing.txt")
	if e := os.WriteFile(file, []byte("preserve"), 0600); e != nil {
		t.Fatal(e)
	}
	junction := filepath.Join(directory, "junction")
	if output, e := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", junction, target).CombinedOutput(); e != nil {
		t.Fatalf("junction creation failed: %v %s", e, output)
	}
	defer os.Remove(junction)
	if e := protectRoot(junction); e == nil {
		t.Fatal("followed a reparse point")
	}
	data, e := os.ReadFile(file)
	if e != nil || string(data) != "preserve" {
		t.Fatal("junction target changed")
	}
}
