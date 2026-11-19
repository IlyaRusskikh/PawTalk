//go:build windows

package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"time"
	"unsafe"
)

type serviceProcess struct {
	handle windows.Handle
	pid    uint32
}

func observeServiceProcess(pid uint32) (*serviceProcess, error) {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil, nil
	}
	// A LocalService process can deny SYNCHRONIZE to an elevated Administrator
	// whose SeDebugPrivilege is disabled. SCM rights still permit stopping it.
	// Observe its lifetime through the read-only process snapshot instead of
	// requiring debug privilege or abandoning Stop after disabling recovery.
	if err != nil && !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return nil, err
	}
	return &serviceProcess{handle: handle, pid: pid}, nil
}
func (p *serviceProcess) close() {
	if p.handle != 0 {
		windows.CloseHandle(p.handle)
	}
}
func (p *serviceProcess) wait(timeout time.Duration) error {
	if p.handle != 0 {
		result, err := windows.WaitForSingleObject(p.handle, uint32(timeout/time.Millisecond))
		if err != nil {
			return err
		}
		if result == windows.WAIT_OBJECT_0 {
			return nil
		}
	} else {
		for deadline := time.Now().Add(timeout); ; time.Sleep(50 * time.Millisecond) {
			alive, err := processPresent(p.pid)
			if err != nil {
				return err
			}
			if !alive {
				return nil
			}
			// PID reuse can only cause a conservative timeout, never early completion.
			if !time.Now().Before(deadline) {
				break
			}
		}
	}
	return errors.New("service process did not exit")
}
func processPresent(pid uint32) (bool, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if entry.ProcessID == pid {
			return true, nil
		}
	}
	if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return false, nil
	}
	return false, err
}
