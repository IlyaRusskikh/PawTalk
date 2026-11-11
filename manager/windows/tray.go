//go:build windows

package main

// A per-user notification icon controls the independent SCM server. It never
// hosts the server itself, and needs elevation only for start/stop operations.
import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

var trayUser = windows.NewLazySystemDLL("user32.dll")
var trayShell = windows.NewLazySystemDLL("shell32.dll")

func trayCall(name string, args ...any) uintptr {
	// Keep temporary UTF-16 strings and native structures pinned until the
	// syscall returns; returning bare uintptr pointers from a helper is unsafe.
	var pinned runtime.Pinner
	defer pinned.Unpin()
	values := make([]uintptr, len(args))
	for i, arg := range args {
		switch value := arg.(type) {
		case int:
			values[i] = uintptr(value)
		case uintptr:
			values[i] = value
		case *uint16:
			pinned.Pin(value)
			values[i] = uintptr(unsafe.Pointer(value))
		case unsafe.Pointer:
			pinned.Pin(value)
			values[i] = uintptr(value)
		default:
			panic("unsupported native tray argument")
		}
	}
	v, _, _ := trayUser.NewProc(name).Call(values...)
	return v
}
func wide(value string) *uint16 { return windows.StringToUTF16Ptr(value) }

type trayPoint struct{ X, Y int32 }
type trayMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          trayPoint
	Private        uint32
}
type trayWindowClass struct {
	Size, Style                        uint32
	Callback                           uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	Menu, Name                         *uint16
	SmallIcon                          uintptr
}
type trayNotify struct {
	Size                uint32
	Window              uintptr
	ID, Flags, Callback uint32
	Icon                uintptr
	Tip                 [128]uint16
	State, StateMask    uint32
	Info                [256]uint16
	Version             uint32
	InfoTitle           [64]uint16
	InfoFlags           uint32
	GUID                windows.GUID
	BalloonIcon         uintptr
}

type trayLabels struct{ Running, Stopped, Pending, Unavailable, Start, Stop, Quit, Exit, Failure, Invite, Reset, Settings string }

func trayText(lang string) trayLabels {
	if lang == "ru" {
		return trayLabels{"Сервер работает", "Сервер остановлен", "Сервер запускается или останавливается", "Служба сервера недоступна", "Включить сервер", "Отключить сервер", "Остановить сервер и выйти", "Закрыть значок (сервер продолжит работу)", "Не удалось изменить состояние сервера. Проверьте службу и права администратора.", "Скопировать приглашение с паролем", "Сменить пароль и скопировать приглашение", "Настройки сервера…"}
	}
	return trayLabels{"Server running", "Server stopped", "Server starting or stopping", "Server service unavailable", "Start server", "Stop server", "Stop server and exit", "Close tray (server keeps running)", "Could not change server state. Check the service and administrator permissions.", "Copy invitation with password", "Reset password and copy invitation", "Server settings…"}
}

func trayState(root string) (svc.State, error) {
	connection, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return 0, err
	}
	defer windows.CloseServiceHandle(connection)
	service, err := windows.OpenService(connection, windows.StringToUTF16Ptr(serviceName("server", root)), windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return 0, err
	}
	defer windows.CloseServiceHandle(service)
	status, err := (&mgr.Service{Handle: service}).Query()
	return status.State, err
}

func trayStatus(state svc.State, err error, labels trayLabels) string {
	if err != nil {
		return labels.Unavailable
	}
	switch state {
	case svc.Running:
		return labels.Running
	case svc.Stopped:
		return labels.Stopped
	default:
		return labels.Pending
	}
}

func trayElevate(action, root, lang string) error {
	if action != "start" && action != "stop" && action != "stop-exit" && action != "invite" && action != "reset-invite" && action != "settings" {
		return errors.New("invalid tray action")
	}
	args := []string{"--tray-control", action, root, lang}
	quoted := make([]string, len(args))
	for i, arg := range args {
		quoted[i] = syscall.EscapeArg(arg)
	}
	return windows.ShellExecute(0, windows.StringToUTF16Ptr("runas"), windows.StringToUTF16Ptr(filepath.Join(base(), "pawtalk-server-tray.exe")), windows.StringToUTF16Ptr(strings.Join(quoted, " ")), nil, windows.SW_HIDE)
}

func trayError(lang string) {
	trayCall("MessageBoxW", 0, wide(trayText(lang).Failure), wide("PawTalk Server"), 0x10)
}

func closeTray(root string) error {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	hash := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(absolute))))
	if err := closeServerWindow(settingsClass(root)); err != nil {
		return err
	}
	return closeServerWindow(fmt.Sprintf("PawTalk.Server.Tray.%x", hash[:8]))
}

func closeServerWindow(class string) error {
	window := trayCall("FindWindowW", wide(class), 0)
	if window == 0 {
		return nil
	}
	var pid uint32
	trayCall("GetWindowThreadProcessId", window, unsafe.Pointer(&pid))
	process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	if trayCall("PostMessageW", window, 0x10, 0, 0) == 0 {
		return errors.New("cannot close Server window")
	}
	result, err := windows.WaitForSingleObject(process, 5000)
	if err != nil {
		return err
	}
	if result != windows.WAIT_OBJECT_0 {
		return errors.New("Server window is busy or did not exit")
	}
	return nil
}

func runTray(root, lang string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	absolute, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	root = filepath.Clean(absolute)
	hash := sha256.Sum256([]byte(strings.ToLower(root)))
	className := fmt.Sprintf("PawTalk.Server.Tray.%x", hash[:8])
	mutex, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr("Local\\"+className))
	if mutex != 0 {
		defer windows.CloseHandle(mutex)
	}
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil
	}
	if err != nil {
		return err
	}
	labels := trayText(lang)
	instance, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	icon := trayCall("LoadImageW", 0, wide(filepath.Join(base(), "server.ico")), 1, 32, 32, 0x10)
	if icon == 0 {
		return errors.New("PawTalk Server icon is missing")
	}
	defer trayCall("DestroyIcon", icon)
	var notify trayNotify
	notify.Size = uint32(unsafe.Sizeof(notify))
	notify.ID, notify.Flags, notify.Callback, notify.Icon = 1, 1|2|4, 0x8001, icon
	notifyIcon := func(operation uintptr) uintptr {
		result, _, _ := trayShell.NewProc("Shell_NotifyIconW").Call(operation, uintptr(unsafe.Pointer(&notify)))
		return result
	}
	update := func() {
		state, err := trayState(root)
		tip := "PawTalk Server — " + trayStatus(state, err, labels)
		notify.Tip = [128]uint16{}
		copy(notify.Tip[:], windows.StringToUTF16(tip))
		trayCall("SetWindowTextW", notify.Window, wide(tip))
		notifyIcon(1)
	}
	command := func(id uintptr) {
		switch id {
		case 1, 2, 4, 5, 6, 7:
			action := "start"
			if id == 7 {
				action = "settings"
			}
			if id == 2 {
				action = "stop"
			}
			if id == 4 {
				action = "stop-exit"
			}
			if id == 5 {
				action = "invite"
			}
			if id == 6 {
				message := "Reset the room password and restart the server? Current calls will be interrupted and old password-bearing invitations will stop working."
				if lang == "ru" {
					message = "Сменить пароль комнаты и перезапустить сервер? Текущие звонки прервутся, старые приглашения с паролем перестанут работать."
				}
				if trayCall("MessageBoxW", notify.Window, wide(message), wide("PawTalk Server"), 0x34) != 6 {
					return
				}
				action = "reset-invite"
			}
			if err := trayElevate(action, root, lang); err != nil {
				trayError(lang)
			}
		case 3:
			trayCall("DestroyWindow", notify.Window)
		}
	}
	menu := func() {
		state, err := trayState(root)
		popup := trayCall("CreatePopupMenu")
		if popup == 0 {
			return
		}
		defer trayCall("DestroyMenu", popup)
		trayCall("AppendMenuW", popup, 2, 0, wide(trayStatus(state, err, labels)))
		trayCall("AppendMenuW", popup, 0x800, 0, 0)
		startFlags, stopFlags := uintptr(2), uintptr(2)
		if err == nil && state == svc.Stopped {
			startFlags = 0
		}
		if err == nil && state == svc.Running {
			stopFlags = 0
		}
		trayCall("AppendMenuW", popup, startFlags, 1, wide(labels.Start))
		trayCall("AppendMenuW", popup, stopFlags, 2, wide(labels.Stop))
		inviteFlags := uintptr(2)
		if err == nil && (state == svc.Running || state == svc.Stopped) {
			inviteFlags = 0
		}
		trayCall("AppendMenuW", popup, 0x800, 0, 0)
		trayCall("AppendMenuW", popup, inviteFlags, 5, wide(labels.Invite))
		trayCall("AppendMenuW", popup, inviteFlags, 6, wide(labels.Reset))
		trayCall("AppendMenuW", popup, inviteFlags, 7, wide(labels.Settings))
		trayCall("AppendMenuW", popup, 0x800, 0, 0)
		quitFlags := uintptr(2)
		if err == nil && (state == svc.Running || state == svc.Stopped) {
			quitFlags = 0
		}
		trayCall("AppendMenuW", popup, quitFlags, 4, wide(labels.Quit))
		trayCall("AppendMenuW", popup, 0, 3, wide(labels.Exit))
		var point trayPoint
		trayCall("GetCursorPos", unsafe.Pointer(&point))
		trayCall("SetForegroundWindow", notify.Window)
		id := trayCall("TrackPopupMenu", popup, 0x100|0x80|2, uintptr(point.X), uintptr(point.Y), 0, notify.Window, 0)
		trayCall("PostMessageW", notify.Window, 0, 0, 0)
		command(id)
	}
	taskbarCreated := trayCall("RegisterWindowMessageW", wide("TaskbarCreated"))
	callback := syscall.NewCallback(func(hwnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
		switch uintptr(message) {
		case taskbarCreated:
			notifyIcon(0)
			update()
		case 0x8001:
			if lparam == 0x205 || lparam == 0x203 || lparam == 0x7b {
				menu()
			}
		case 0x113:
			update() // WM_TIMER
		case 0x111:
			command(wparam & 0xffff) // WM_COMMAND
		case 0x10:
			trayCall("DestroyWindow", hwnd)
		case 2:
			notifyIcon(2)
			trayCall("PostQuitMessage", 0)
		default:
			return trayCall("DefWindowProcW", hwnd, uintptr(message), wparam, lparam)
		}
		return 0
	})
	class := trayWindowClass{Callback: callback, Instance: instance, Name: windows.StringToUTF16Ptr(className)}
	class.Size = uint32(unsafe.Sizeof(class))
	if trayCall("RegisterClassExW", unsafe.Pointer(&class)) == 0 {
		return errors.New("cannot register Server tray window")
	}
	defer trayCall("UnregisterClassW", wide(className), instance)
	window := trayCall("CreateWindowExW", 0, wide(className), wide("PawTalk Server"), 0, 0, 0, 0, 0, 0, 0, instance, 0)
	if window == 0 {
		return errors.New("cannot create Server tray window")
	}
	notify.Window = window
	defer trayCall("DestroyWindow", window)
	// Keep legacy callback semantics (version 0), including WM_RBUTTONUP.
	if notifyIcon(0) == 0 {
		return errors.New("cannot add Server notification icon")
	}
	update()
	trayCall("SetTimer", window, 1, 2000, 0)
	var message trayMessage
	for {
		result := int32(trayCall("GetMessageW", unsafe.Pointer(&message), 0, 0, 0))
		if result == -1 {
			return errors.New("Server tray message loop failed")
		}
		if result == 0 {
			return nil
		}
		trayCall("TranslateMessage", unsafe.Pointer(&message))
		trayCall("DispatchMessageW", unsafe.Pointer(&message))
	}
}

func trayMain(args []string) int {
	if len(args) == 1 && args[0] == "--self-test" {
		if guiHostSelfTest() != nil {
			return 1
		}
		return 0
	}
	if len(args) == 2 {
		var err error
		switch args[0] {
		case "--prepare-install":
			err = prepareInstall(args[1])
		case "--uninstall-services":
			err = uninstallServices(args[1])
		case "--retire-legacy":
			err = retireLegacyInstall(args[1])
		default:
			goto normalTray
		}
		if err != nil {
			return 1
		}
		return 0
	}
normalTray:
	if len(args) == 2 && args[0] == "--close-tray" {
		if closeTray(args[1]) != nil {
			return 1
		}
		return 0
	}
	root, lang := defaultRoot(), "en"
	language, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage").Call()
	if language&0x3ff == 0x19 {
		lang = "ru"
	}
	if len(args) >= 2 && args[0] == "--root" {
		root, args = args[1], args[2:]
	}
	if len(args) >= 2 && args[0] == "--lang" {
		lang, args = args[1], args[2:]
	}
	if len(args) == 4 && args[0] == "--tray-control" {
		if (args[1] != "start" && args[1] != "stop" && args[1] != "stop-exit" && args[1] != "invite" && args[1] != "reset-invite" && args[1] != "settings") || (args[3] != "ru" && args[3] != "en") {
			return 1
		}
		if args[1] == "settings" {
			if !windows.GetCurrentProcessToken().IsElevated() {
				if trayElevate("settings", args[2], args[3]) != nil {
					return 1
				}
				return 0
			}
			if showSettings(args[2], args[3], func(request *settingsRequest) (map[string]string, error) { return settingsOperation(args[2], request) }) != nil {
				return 1
			}
			return 0
		}
		if args[1] == "invite" || args[1] == "reset-invite" {
			if copyInvitation(args[2], args[3], args[1] == "reset-invite") != nil {
				return 1
			}
			return 0
		}
		action := args[1]
		if action == "stop-exit" {
			action = "stop"
		}
		if err := control(action+"-server", args[2]); err != nil {
			trayError(args[3])
			return 1
		}
		if args[1] == "stop-exit" && closeTray(args[2]) != nil {
			trayError(args[3])
			return 1
		}
		return 0
	}
	if len(args) != 0 {
		return 1
	}
	if err := runTray(root, lang); err != nil {
		trayError(lang)
		return 1
	}
	return 0
}

func isTrayExecutable() bool {
	return strings.EqualFold(filepath.Base(os.Args[0]), "pawtalk-server-tray.exe")
}
