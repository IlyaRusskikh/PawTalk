//go:build windows

package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unsafe"
)

func noLinks(path string) error {
	for current := path; ; current = filepath.Dir(current) {
		attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(current))
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("managed path contains a link/junction")
		}
		if current == filepath.Dir(current) {
			break
		}
	}
	return filepath.WalkDir(path, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(file))
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("managed tree contains a link/junction")
		}
		return nil
	})
}

func validateDataRemoval(root, parent string) error {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	allowed, err := filepath.Abs(parent)
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Dir(absolute), allowed) {
		return errors.New("data root must be a dedicated direct child of ProgramData")
	}
	marker, err := os.ReadFile(filepath.Join(absolute, ".pawtalk-manager-root"))
	if err != nil || (string(marker) != "pawtalk-manager-v1" && string(marker) != "pawtalk-manager-initializing-v1") {
		return errors.New("data ownership marker missing or invalid")
	}
	return noLinks(absolute)
}

func purgeData(root string) error {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	root = absolute
	parent, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return err
	}
	if err := validateDataRemoval(root, parent); err != nil {
		return err
	}
	// Refuse deletion while either service is still registered.
	if serviceExists("server", root) || serviceExists("manager", root) {
		return errors.New("uninstall services before removing data")
	}
	return removeOwnedData(root, parent)
}

func removeOwnedData(root, parent string) error {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	if err := validateDataRemoval(absolute, parent); err != nil {
		return err
	}
	return os.RemoveAll(absolute)
}

func validateInstallRemoval(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(absolute), filepath.Clean(base())) {
		return errors.New("installation path must match the executing host")
	}
	marker, err := os.ReadFile(filepath.Join(absolute, ".pawtalk-manager-install"))
	if err != nil || string(marker) != "pawtalk-manager-install-v1" {
		return errors.New("installation ownership marker missing")
	}
	return noLinks(absolute)
}

func prepareInstall(path string) error {
	parent, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if !strings.EqualFold(absolute, filepath.Join(parent, "PawTalk Server Manager")) {
		return errors.New("use the dedicated ProgramData installation directory")
	}
	sd, err := descriptor("GRGX", true)
	if err != nil {
		return err
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err := windows.CreateDirectory(windows.StringToUTF16Ptr(absolute), &attributes); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return err
	}
	if err := noLinks(absolute); err != nil {
		return err
	}
	existing, err := windows.GetNamedSecurityInfo(absolute, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := existing.Owner()
	if err != nil {
		return err
	}
	control, _, err := existing.Control()
	if err != nil {
		return err
	}
	if (owner.String() != "S-1-5-32-544" && owner.String() != "S-1-5-18") || control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("installation directory is not administrator-owned and protected")
	}
	marker := filepath.Join(absolute, ".pawtalk-manager-install")
	if data, err := os.ReadFile(marker); err == nil {
		if string(data) != "pawtalk-manager-install-v1" {
			return errors.New("installation ownership mismatch")
		}
	} else {
		entries, readErr := os.ReadDir(absolute)
		if readErr != nil {
			return readErr
		}
		if len(entries) != 0 {
			return errors.New("refusing to adopt an unowned installation directory")
		}
	}
	if err := applySecurity(absolute, "GRGX", true); err != nil {
		return err
	}
	return os.WriteFile(marker, []byte("pawtalk-manager-install-v1"), 0600)
}

func retireLegacyInstall(path string) error {
	parent, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFilesX64, 0)
	if err != nil {
		return err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if !strings.EqualFold(absolute, filepath.Join(parent, "PawTalk Server Manager")) {
		return errors.New("unexpected legacy installation directory")
	}
	if _, err := os.Stat(absolute); os.IsNotExist(err) {
		return nil
	}
	if err := noLinks(absolute); err != nil {
		return err
	}
	for _, file := range []string{"pawtalkctl.exe", "runtime/python.exe", "bootstrap/manager/pawtalkctl"} {
		if info, err := os.Stat(filepath.Join(absolute, filepath.FromSlash(file))); err != nil || !info.Mode().IsRegular() {
			return errors.New("legacy installation is incomplete; preserved for manual review")
		}
	}
	return os.RemoveAll(absolute)
}

func serviceExists(kind, root string) bool {
	connection, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return true
	}
	defer windows.CloseServiceHandle(connection)
	service, err := windows.OpenService(connection, windows.StringToUTF16Ptr(serviceName(kind, root)), windows.SERVICE_QUERY_STATUS)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return false
	}
	if err != nil {
		return true
	}
	windows.CloseServiceHandle(service)
	return true
}

func uninstallServices(root string) error {
	for _, action := range []string{"stop-manager", "stop-server", "uninstall-manager", "uninstall-server"} {
		if err := control(action, root); err != nil {
			return err
		}
	}
	return nil
}
