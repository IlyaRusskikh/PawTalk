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
			return args[0] == "install" || args[0] == "invitation" || args[0] == "settings"
		}
	}
	return false
}

func copyInvitation(root, lang string, reset bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	args := []string{"--root", root, "--lang", lang, "invitation", "--url"}
	if reset {
		args = append(args, "--reset-password", "--yes")
	}
	command := python(ctx, filepath.Join(base(), "bootstrap", "manager", "pawtalkctl"), args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := command.Output()
	if err != nil {
		message := "Could not get the invitation. Open Status / Doctor to check the Manager and server."
		if lang == "ru" {
			message = "Не удалось получить приглашение. Откройте Status / Doctor для проверки Manager и сервера."
		}
		if reset {
			message = "Could not reset the password or restart the server. Open Status / Doctor to check the server."
			if lang == "ru" {
				message = "Не удалось сменить пароль или перезапустить сервер. Откройте Status / Doctor для проверки сервера."
			}
		} else {
			var failure *exec.ExitError
			if errors.As(err, &failure) && failure.ExitCode() == 2 {
				message = "The old password was not saved. Use Reset password and copy invitation. Resetting interrupts calls."
				if lang == "ru" {
					message = "Старый пароль не сохранён или недоступен. Используйте «Сменить пароль и скопировать приглашение». Смена пароля прерывает звонки."
				}
			}
		}
		trayCall("MessageBoxW", 0, wide(message), wide("PawTalk Server"), 0x10)
		return err
	}
	value := strings.TrimSpace(string(output))
	if !strings.HasPrefix(value, "pawtalk://") || !strings.Contains(value, "#password=") || len(value) > 14000 {
		return errors.New("invalid invitation output")
	}
	if err := putClipboard(value); err != nil {
		return err
	}
	message := "Invitation with password copied. Share it privately. Share the E2EE secret separately if enabled."
	if lang == "ru" {
		message = "Приглашение с паролем скопировано. Отправляйте его лично. При включённом E2EE секретный ключ передаётся отдельно."
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
