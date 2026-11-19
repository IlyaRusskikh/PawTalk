//go:build windows

package main

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

func bootstrapCommand(args []string) bool {
	for len(args) > 0 {
		switch args[0] {
		case "--lang":
			if len(args) < 2 {
				return false
			}
			args = args[2:]
		case "--no-systemd":
			args = args[1:]
		default:
			return args[0] == "--help" || args[0] == "-h" || args[0] == "logs" || args[0] == "uninstall" || args[0] == "manager-install" || args[0] == "status" || args[0] == "doctor" || args[0] == "backup" || args[0] == "configure" || args[0] == "setup" || args[0] == "update" || args[0] == "manager" || args[0] == "--self-test" || args[0] == "install" || args[0] == "initial-admin" || args[0] == "settings" || args[0] == "desktop" || args[0] == "periodic" || args[0] == "health" || args[0] == "run-server"
		}
	}
	return false
}

func copyInitialAdmin(root, lang string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	args := []string{"--root", root, "--lang", lang, "initial-admin", "--url"}
	command := python(ctx, filepath.Join(base(), "bootstrap", "manager", "pawtalkctl"), args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := command.Output()
	if err != nil {
		message := "Could not create the first administrator link. Start a compatible server and check Manager diagnostics."
		if lang == "ru" {
			message = "Не удалось создать ссылку первого администратора. Запустите совместимый сервер и проверьте диагностику Manager."
		}
		var failure *exec.ExitError
		if errors.As(err, &failure) && failure.ExitCode() == 2 {
			message = "This server is already initialized. Administrators and moderators create invitations in the client."
			if lang == "ru" {
				message = "Сервер уже настроен. Приглашения создают администраторы и модераторы в клиенте."
			}
		}
		trayCall("MessageBoxW", 0, wide(message), wide("PawTalk Server"), 0x10)
		return err
	}
	value := strings.TrimSpace(string(output))
	if !validInitialInvitation(value) {
		return errors.New("invalid administrator invitation output")
	}
	if err := putClipboard(value); err != nil {
		return err
	}
	message := "The single-use administrator link was copied. It expires in 24 hours. A new link revokes the previous one."
	if lang == "ru" {
		message = "Одноразовая административная ссылка скопирована. Срок — 24 часа. Новая ссылка отменяет предыдущую."
	}
	trayCall("MessageBoxW", 0, wide(message), wide("PawTalk Server"), 0x40)
	return nil
}

func guiHostSelfTest() error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// Exercise the actual GUI -> embedded Python -> console-host route. This
	// needs no elevation and never reads or changes an installed room.
	code := "import os,subprocess;host=os.environ['PAWTALK_MANAGER_HOST'];plain=b'PawTalk GUI host protocol self-test';sealed=subprocess.run([host,'seal-credential'],input=plain,capture_output=True,check=True).stdout;opened=subprocess.run([host,'unseal-credential'],input=sealed,capture_output=True,check=True).stdout;assert opened==plain"
	command := python(ctx, "-c", code)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return command.Run()
}

func putClipboard(value string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	owner := trayCall("CreateWindowExW", 0, wide("STATIC"), wide("PawTalk Clipboard"), 0, 0, 0, 0, 0, 0, 0, 0, 0)
	if owner == 0 {
		return errors.New("cannot create clipboard owner")
	}
	defer trayCall("DestroyWindow", owner)
	text := windows.StringToUTF16(value)
	size := uintptr(len(text) * 2)
	handle, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalAlloc").Call(0x2, size)
	if handle == 0 {
		return errors.New("clipboard allocation failed")
	}
	owned := true
	defer func() {
		if owned {
			windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalFree").Call(handle)
		}
	}()
	pointer, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalLock").Call(handle)
	if pointer == 0 {
		return errors.New("clipboard lock failed")
	}
	windows.NewLazySystemDLL("kernel32.dll").NewProc("RtlMoveMemory").Call(pointer, uintptr(unsafe.Pointer(&text[0])), size)
	windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalUnlock").Call(handle)
	// Another application can briefly own the clipboard; retry without clearing
	// it until we hold the lock and have the complete replacement ready.
	opened := false
	for i := 0; i < 10; i++ {
		if trayCall("OpenClipboard", owner) != 0 {
			opened = true
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if !opened {
		return errors.New("clipboard busy")
	}
	defer trayCall("CloseClipboard")
	if trayCall("EmptyClipboard") == 0 {
		return errors.New("cannot clear clipboard")
	}
	if trayCall("SetClipboardData", 13, handle) == 0 {
		return errors.New("cannot set clipboard text")
	}
	owned = false
	return nil
}

// User-scoped DPAPI keeps the LocalService server from decrypting the saved
// password even if it can read the private data root. Another administrator
// can explicitly reset the password, but cannot recover this user's receipt.
func credentialBytes(data []byte, decrypt bool) ([]byte, error) {
	if len(data) == 0 || len(data) > 8192 {
		return nil, errors.New("invalid credential size")
	}
	input := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var output windows.DataBlob
	var err error
	if decrypt {
		err = windows.CryptUnprotectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	} else {
		err = windows.CryptProtectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output)
	}
	if err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return append([]byte(nil), unsafe.Slice(output.Data, output.Size)...), nil
}

func credentialCommand(decrypt bool) error {
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 8193))
	if err != nil {
		return err
	}
	result, err := credentialBytes(data, decrypt)
	if err != nil {
		return errors.New("Windows credential protection failed")
	}
	_, err = os.Stdout.Write(result)
	return err
}
