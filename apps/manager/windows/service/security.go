//go:build windows

package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func descriptor(localRights string, public ...bool) (*windows.SECURITY_DESCRIPTOR, error) {
	extra := ""
	if len(public) > 0 && public[0] {
		extra = "(A;OICI;GRGX;;;BU)"
	}
	return windows.SecurityDescriptorFromString("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;" + localRights + ";;;LS)" + extra)
}

func applySecurity(path, localRights string, public ...bool) error {
	sd, e := descriptor(localRights, public...)
	if e != nil {
		return e
	}
	owner, _, e := sd.Owner()
	if e != nil {
		return e
	}
	group, _, e := sd.Group()
	if e != nil {
		return e
	}
	dacl, _, e := sd.DACL()
	if e != nil {
		return e
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner, group, dacl, nil)
}

func protectRoot(root string) error {
	root, e := filepath.Abs(root)
	if e != nil {
		return e
	}
	if filepath.Clean(root) == filepath.VolumeName(root)+string(filepath.Separator) {
		return errors.New("a dedicated Manager directory is required")
	}
	if e = os.MkdirAll(root, 0700); e != nil {
		return e
	}
	check := func(path string) error {
		pointer, e := windows.UTF16PtrFromString(path)
		if e != nil {
			return e
		}
		attributes, e := windows.GetFileAttributes(pointer)
		if e != nil {
			return e
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("links/junctions are not allowed in the Manager root")
		}
		return nil
	}
	if e = check(root); e != nil {
		return e
	}
	for parent := filepath.Dir(root); parent != filepath.Dir(parent); parent = filepath.Dir(parent) {
		if e = check(parent); e != nil {
			return e
		}
	}
	marker := filepath.Join(root, ".pawtalk-manager-root")
	data, e := os.ReadFile(marker)
	newRoot := os.IsNotExist(e)
	if newRoot {
		entries, err := os.ReadDir(root)
		if err != nil {
			return err
		}
		if len(entries) != 0 {
			return errors.New("refusing to adopt an unowned nonempty root")
		}
	} else if e != nil {
		return e
	} else if string(data) != "pawtalk-manager-v1" && string(data) != "pawtalk-manager-initializing-v1" {
		return errors.New("root ownership marker mismatch")
	} else {
		sd, err := windows.GetNamedSecurityInfo(root, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		owner, _, err := sd.Owner()
		if err != nil {
			return err
		}
		control, _, err := sd.Control()
		if err != nil {
			return err
		}
		if (owner.String() != "S-1-5-32-544" && owner.String() != "S-1-5-18") || control&windows.SE_DACL_PROTECTED == 0 {
			return errors.New("root is not owned/protected by Administrators or SYSTEM")
		}
		// New objects are secured before publication. Do not recursively walk
		// active SQLite/cache files on every watchdog invocation.
		if string(data) == "pawtalk-manager-v1" {
			return nil
		}
	}
	// Secure the root before creating descendants. Reject reparse points before
	// touching any child; no traversal into user-controlled external directories.
	if e = applySecurity(root, "GRGX"); e != nil {
		return e
	}
	if newRoot {
		// Create the marker with its final owner/DACL atomically. An ordinary
		// token of the installing user must not be able to commit initialization.
		sd, err := descriptor("GRGX")
		if err != nil {
			return err
		}
		attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
		pointer, err := windows.UTF16PtrFromString(marker)
		if err != nil {
			return err
		}
		handle, err := windows.CreateFile(pointer, windows.GENERIC_WRITE, windows.FILE_SHARE_READ, &attributes, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(handle), marker)
		_, err = file.Write([]byte("pawtalk-manager-initializing-v1"))
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	for _, directory := range []string{"etc/pawtalk", "var/lib/pawtalk-manager", "var/lib/pawtalk-data", "var/log/pawtalk", "var/backups/pawtalk", "opt/pawtalk", "opt/pawtalk-manager/versions", "opt/pawtalk-server", "usr/local/bin"} {
		path := filepath.Join(root, filepath.FromSlash(directory))
		// Existing path components are checked by the complete walk below; refuse
		// reparse points before MkdirAll could traverse them.
		current := root
		for _, part := range strings.Split(filepath.FromSlash(directory), string(filepath.Separator)) {
			current = filepath.Join(current, part)
			if _, err := os.Lstat(current); err == nil {
				if err = check(current); err != nil {
					return err
				}
			}
		}
		if e = os.MkdirAll(path, 0700); e != nil {
			return e
		}
	}
	e = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = check(path); err != nil {
			return err
		}
		if !entry.IsDir() && path != marker {
			return errors.New("unexpected file during root initialization")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		normalized := strings.ToLower(filepath.ToSlash(relative))
		rights := "GRGX"
		for _, directory := range []string{"var/lib/pawtalk-data", "var/log/pawtalk"} {
			if normalized == directory || strings.HasPrefix(normalized, directory+"/") {
				rights = "0x1301bf"
			}
		}
		return applySecurity(path, rights)
	})
	if e != nil {
		return e
	}
	return os.WriteFile(marker, []byte("pawtalk-manager-v1"), 0600)
}

func secureTree(path string) error {
	path, e := filepath.Abs(path)
	if e != nil {
		return e
	}
	root := path
	for {
		if data, err := os.ReadFile(filepath.Join(root, ".pawtalk-manager-root")); err == nil && string(data) == "pawtalk-manager-v1" {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			return errors.New("file is outside an owned Manager root")
		}
		root = parent
	}
	return filepath.WalkDir(path, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		pointer, e := windows.UTF16PtrFromString(file)
		if e != nil {
			return e
		}
		attributes, e := windows.GetFileAttributes(pointer)
		if e != nil {
			return e
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("managed files contain a link")
		}
		relative, e := filepath.Rel(root, file)
		if e != nil {
			return e
		}
		normalized := strings.ToLower(filepath.ToSlash(relative))
		rights := "GRGX"
		for _, directory := range []string{"var/lib/pawtalk-data", "var/log/pawtalk"} {
			if normalized == directory || strings.HasPrefix(normalized, directory+"/") {
				rights = "0x1301bf"
			}
		}
		return applySecurity(file, rights)
	})
}

func protectInstall(path string) error {
	absolute, e := filepath.Abs(path)
	if e != nil {
		return e
	}
	if !strings.EqualFold(filepath.Clean(absolute), filepath.Clean(base())) {
		return errors.New("installer path must match this host executable")
	}
	if err := noLinks(absolute); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(absolute, ".pawtalk-manager-install"), []byte("pawtalk-manager-install-v1"), 0600); err != nil {
		return err
	}
	return filepath.WalkDir(absolute, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		pointer, e := windows.UTF16PtrFromString(file)
		if e != nil {
			return e
		}
		attributes, e := windows.GetFileAttributes(pointer)
		if e != nil {
			return e
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("installer directory contains a link")
		}
		return applySecurity(file, "GRGX", true)
	})
}
