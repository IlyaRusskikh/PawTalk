//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type settingsRequest struct {
	Expected map[string]string `json:"expected"`
	Values   map[string]string `json:"values"`
}
type settingsBackend func(*settingsRequest) (map[string]string, error)

func settingsOperation(root string, request *settingsRequest) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	args := []string{"--root", root, "settings"}
	var input []byte
	if request != nil {
		args = append(args, "--apply")
		var err error
		input, err = json.Marshal(request)
		if err != nil {
			return nil, err
		}
	}
	command := python(ctx, filepath.Join(base(), "bootstrap", "manager", "pawtalkctl"), args...)
	command.Stdin = bytes.NewReader(input)
	output, err := command.Output()
	if err != nil {
		return nil, errors.New("settings operation failed")
	}
	var result struct {
		Values map[string]string `json:"values"`
	}
	if len(output) > 32768 || json.Unmarshal(output, &result) != nil || result.Values == nil {
		return nil, errors.New("invalid settings response")
	}
	if request != nil {
		saveUILanguage(root, result.Values["PAWTALK_LANGUAGE"])
	}
	return result.Values, nil
}

type settingsLabels struct{ Title, IP, Port, E2EE, Key, History, ServerUpdate, ManagerUpdate, Language, Notice, Apply, Cancel, Busy, Success, Failure, Invalid, Confirm string }

func settingsText(lang string) settingsLabels {
	if lang == "ru" {
		return settingsLabels{
			"Настройки сервера PawTalk", "IPv4-адрес сервера", "Основной порт (TCP; также используются TCP +1 и UDP +2)",
			"Включить сквозное шифрование E2EE", "SHA-256 key ID — отпечаток, НЕ секретный ключ",
			"Лимит истории, МиБ (0 — без ограничения)", "Автообновление сервера", "Автообновление Server Manager", "Язык Manager",
			"Сетевые настройки, E2EE и лимит истории применяются с перезапуском и резервной копией. После смены IP или порта раздайте новое приглашение. Проверьте проброс портов и брандмауэр.",
			"Применить", "Закрыть", "Применение настроек…", "Настройки сохранены.",
			"Не удалось загрузить или применить настройки. Откройте Status / Doctor. Если конфигурация изменилась в другом окне, откройте настройки заново. Для смены IP требуется обновлённый Server с поддержкой rebind.",
			"Проверьте IPv4, порт 1024–65532, key ID (64 символа 0–9/a–f при включённом E2EE) и лимит истории 0–1048576.",
			"Применить изменения? Если меняются сетевые настройки, E2EE или лимит истории, текущие звонки прервутся. После смены IP или порта потребуется новое приглашение."}
	}
	return settingsLabels{"PawTalk Server settings", "Server IPv4 address", "Base port (TCP; also uses TCP +1 and UDP +2)",
		"Enable end-to-end encryption (E2EE)", "SHA-256 key ID — fingerprint, NOT the secret key",
		"History limit, MiB (0 = unlimited)", "Automatically update Server", "Automatically update Server Manager", "Manager language",
		"Network, E2EE and history changes create a backup and restart the server. Share a new invitation after changing IP or port. Check port forwarding and firewall rules.",
		"Apply", "Close", "Applying settings…", "Settings saved.",
		"Could not load or apply settings. Open Status / Doctor. If settings changed in another window, reopen this window. Changing IP requires an updated Server with rebind support.",
		"Check IPv4, port 1024–65532, key ID (64 characters 0–9/a–f when E2EE is enabled) and history limit 0–1048576.",
		"Apply changes? Network, E2EE or history changes will interrupt current calls. Changing IP or port requires a new invitation."}
}

var settingsKeyPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var settingsNumberPattern = regexp.MustCompile(`^[0-9]+$`)

func validSettings(values map[string]string) bool {
	ip := net.ParseIP(values["PAWTALK_PUBLIC_IP"])
	if ip == nil || ip.To4() == nil || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	for _, bound := range []struct {
		key              string
		min, max, length int
	}{{"PAWTALK_PORT", 1024, 65532, 5}, {"PAWTALK_CHAT_MAX_MB", 0, 1048576, 7}} {
		raw := values[bound.key]
		n, err := strconv.Atoi(raw)
		if err != nil || !settingsNumberPattern.MatchString(raw) || len(raw) > bound.length || n < bound.min || n > bound.max {
			return false
		}
	}
	for _, key := range []string{"PAWTALK_E2EE", "PAWTALK_SERVER_AUTO_UPDATE", "PAWTALK_MANAGER_AUTO_UPDATE"} {
		if values[key] != "true" && values[key] != "false" {
			return false
		}
	}
	key := values["PAWTALK_E2EE_KEY_ID"]
	return (key == "" && values["PAWTALK_E2EE"] == "false" || settingsKeyPattern.MatchString(key)) && (values["PAWTALK_LANGUAGE"] == "ru" || values["PAWTALK_LANGUAGE"] == "en")
}

func settingsClass(root string) string {
	absolute, _ := filepath.Abs(root)
	hash := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(absolute))))
	return fmt.Sprintf("PawTalk.Server.Settings.%x", hash[:8])
}
func windowText(window uintptr) string {
	var text [4096]uint16
	trayCall("GetWindowTextW", window, unsafe.Pointer(&text[0]), len(text))
	return windows.UTF16ToString(text[:])
}

func showSettings(root, lang string, backend settingsBackend) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	labels := settingsText(lang)
	className := settingsClass(root)
	mutex, err := windows.CreateMutex(nil, false, wide("Local\\"+className))
	if mutex != 0 {
		defer windows.CloseHandle(mutex)
	}
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		if existing := trayCall("FindWindowW", wide(className), 0); existing != 0 {
			trayCall("ShowWindow", existing, 9)
			trayCall("SetForegroundWindow", existing)
		}
		return nil
	}
	if err != nil {
		return err
	}
	values, err := backend(nil)
	if err != nil {
		trayCall("MessageBoxW", 0, wide(labels.Failure), wide(labels.Title), 0x10)
		return err
	}
	if saved := values["PAWTALK_LANGUAGE"]; saved == "ru" || saved == "en" {
		lang = saved
		labels = settingsText(lang)
	}
	instance, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	var window uintptr
	controls := map[string]uintptr{}
	textControls := map[string]uintptr{}
	var apply, cancel uintptr
	var relabel func()
	var submit func(*settingsRequest, bool)
	busy := false
	type outcome struct {
		values       map[string]string
		err          error
		languageOnly bool
	}
	finished := make(chan outcome, 1)
	callback := syscall.NewCallback(func(hwnd uintptr, message uint32, wparam, lparam uintptr) uintptr {
		switch message {
		case 0x111:
			switch wparam & 0xffff {
			case 2:
				if !busy {
					trayCall("DestroyWindow", hwnd)
				}
			case 103:
				trayCall("EnableWindow", controls["PAWTALK_E2EE_KEY_ID"], trayCall("SendMessageW", controls["PAWTALK_E2EE"], 0xf0, 0, 0))
			case 108:
				if wparam>>16 != 1 || busy {
					return 0
				} // CBN_SELCHANGE
				lang = "en"
				if trayCall("SendMessageW", controls["PAWTALK_LANGUAGE"], 0x147, 0, 0) == 0 {
					lang = "ru"
				}
				labels = settingsText(lang)
				relabel()
				if lang != values["PAWTALK_LANGUAGE"] {
					submit(settingsLanguageRequest(values, lang), true)
				}
			case 1:
				if busy {
					return 0
				}
				next := map[string]string{}
				for _, key := range []string{"PAWTALK_PUBLIC_IP", "PAWTALK_PORT", "PAWTALK_E2EE_KEY_ID", "PAWTALK_CHAT_MAX_MB"} {
					next[key] = strings.TrimSpace(windowText(controls[key]))
				}
				next["PAWTALK_E2EE_KEY_ID"] = strings.ToLower(next["PAWTALK_E2EE_KEY_ID"])
				for _, key := range []string{"PAWTALK_E2EE", "PAWTALK_SERVER_AUTO_UPDATE", "PAWTALK_MANAGER_AUTO_UPDATE"} {
					next[key] = strconv.FormatBool(trayCall("SendMessageW", controls[key], 0xf0, 0, 0) == 1)
				}
				next["PAWTALK_LANGUAGE"] = "en"
				if trayCall("SendMessageW", controls["PAWTALK_LANGUAGE"], 0x147, 0, 0) == 0 {
					next["PAWTALK_LANGUAGE"] = "ru"
				}
				if !validSettings(next) {
					trayCall("MessageBoxW", hwnd, wide(labels.Invalid), wide(labels.Title), 0x30)
					return 0
				}
				changed := false
				for key, value := range next {
					if values[key] != value {
						changed = true
					}
				}
				if !changed {
					return 0
				}
				if trayCall("MessageBoxW", hwnd, wide(labels.Confirm), wide(labels.Title), 0x34) != 6 {
					return 0
				}
				request := &settingsRequest{Expected: values, Values: next}
				submit(request, false)
			}
		case 0x8006:
			result := <-finished
			busy = false
			trayCall("SetWindowTextW", apply, wide(labels.Apply))
			trayCall("EnableWindow", apply, 1)
			trayCall("EnableWindow", cancel, 1)
			for _, control := range controls {
				trayCall("EnableWindow", control, 1)
			}
			trayCall("EnableWindow", controls["PAWTALK_E2EE_KEY_ID"], trayCall("SendMessageW", controls["PAWTALK_E2EE"], 0xf0, 0, 0))
			if result.err != nil {
				if result.languageOnly {
					lang = values["PAWTALK_LANGUAGE"]
					labels = settingsText(lang)
					relabel()
					selected := 0
					if lang == "en" {
						selected = 1
					}
					trayCall("SendMessageW", controls["PAWTALK_LANGUAGE"], 0x14e, selected, 0)
				}
				trayCall("MessageBoxW", hwnd, wide(labels.Failure), wide(labels.Title), 0x10)
			} else {
				values = result.values
				notifyTrayLanguage(root, values["PAWTALK_LANGUAGE"])
				if !result.languageOnly {
					trayCall("MessageBoxW", hwnd, wide(labels.Success), wide(labels.Title), 0x40)
				}
			}
		case 0x10:
			if !busy {
				trayCall("DestroyWindow", hwnd)
			}
		case 2:
			trayCall("PostQuitMessage", 0)
		default:
			return trayCall("DefWindowProcW", hwnd, int(message), wparam, lparam)
		}
		return 0
	})
	class := trayWindowClass{Callback: callback, Instance: instance, Name: wide(className), Background: 16}
	class.Size = uint32(unsafe.Sizeof(class))
	if trayCall("RegisterClassExW", unsafe.Pointer(&class)) == 0 {
		return errors.New("cannot register settings window")
	}
	defer trayCall("UnregisterClassW", wide(className), instance)
	dpi := trayCall("GetDpiForSystem")
	if dpi == 0 {
		dpi = 96
	}
	scale := func(value int) int { return value * int(dpi) / 96 }
	window = trayCall("CreateWindowExW", 0x10000, wide(className), wide(labels.Title), 0x00ca0000, scale(160), scale(100), scale(680), scale(690), 0, 0, instance, 0)
	if window == 0 {
		return errors.New("cannot create settings window")
	}
	defer trayCall("DestroyWindow", window)
	icon := trayCall("LoadImageW", 0, wide(filepath.Join(base(), "server.ico")), 1, 32, 32, 0x10)
	if icon != 0 {
		defer trayCall("DestroyIcon", icon)
		trayCall("SendMessageW", window, 0x80, 0, icon)
		trayCall("SendMessageW", window, 0x80, 1, icon)
	}
	fontName := windows.StringToUTF16Ptr("Segoe UI")
	font, _, _ := windows.NewLazySystemDLL("gdi32.dll").NewProc("CreateFontW").Call(uintptr(scale(16)), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, uintptr(unsafe.Pointer(fontName)))
	runtime.KeepAlive(fontName)
	if font != 0 {
		defer windows.NewLazySystemDLL("gdi32.dll").NewProc("DeleteObject").Call(font)
	}
	create := func(kind, text string, style, id, x, y, width, height int) uintptr {
		ex := 0
		if kind == "EDIT" {
			ex = 0x200
		}
		control := trayCall("CreateWindowExW", ex, wide(kind), wide(text), 0x50000000|style, scale(x), scale(y), scale(width), scale(height), window, id, instance, 0)
		if font != 0 {
			trayCall("SendMessageW", control, 0x30, font, 1)
		}
		return control
	}
	field := func(key, label string, id, y int) {
		textControls[key] = create("STATIC", label, 0, 0, 24, y, 620, 23)
		controls[key] = create("EDIT", values[key], 0x10000|0x80, id, 24, y+26, 620, 28)
		trayCall("SendMessageW", controls[key], 0xc5, 128, 0)
	}
	checkbox := func(key, label string, id, y int) {
		controls[key] = create("BUTTON", label, 0x10000|3, id, 24, y, 620, 28)
		if values[key] == "true" {
			trayCall("SendMessageW", controls[key], 0xf1, 1, 0)
		}
	}
	field("PAWTALK_PUBLIC_IP", labels.IP, 101, 18)
	field("PAWTALK_PORT", labels.Port, 102, 88)
	checkbox("PAWTALK_E2EE", labels.E2EE, 103, 158)
	field("PAWTALK_E2EE_KEY_ID", labels.Key, 104, 204)
	field("PAWTALK_CHAT_MAX_MB", labels.History, 105, 274)
	checkbox("PAWTALK_SERVER_AUTO_UPDATE", labels.ServerUpdate, 106, 344)
	checkbox("PAWTALK_MANAGER_AUTO_UPDATE", labels.ManagerUpdate, 107, 382)
	textControls["PAWTALK_LANGUAGE"] = create("STATIC", labels.Language, 0, 0, 24, 426, 260, 25)
	controls["PAWTALK_LANGUAGE"] = create("COMBOBOX", "", 0x10000|3|0x200000, 108, 290, 422, 354, 160)
	for _, name := range []string{"Русский", "English"} {
		trayCall("SendMessageW", controls["PAWTALK_LANGUAGE"], 0x143, 0, wide(name))
	}
	selected := 0
	if values["PAWTALK_LANGUAGE"] == "en" {
		selected = 1
	}
	trayCall("SendMessageW", controls["PAWTALK_LANGUAGE"], 0x14e, selected, 0)
	textControls["notice"] = create("STATIC", labels.Notice, 0, 0, 24, 470, 620, 98)
	apply = create("BUTTON", labels.Apply, 0x10000|1, 1, 340, 594, 160, 34)
	cancel = create("BUTTON", labels.Cancel, 0x10000, 2, 512, 594, 132, 34)
	relabel = func() {
		trayCall("SetWindowTextW", window, wide(labels.Title))
		for key, text := range map[string]string{"PAWTALK_PUBLIC_IP": labels.IP, "PAWTALK_PORT": labels.Port, "PAWTALK_E2EE_KEY_ID": labels.Key, "PAWTALK_CHAT_MAX_MB": labels.History, "PAWTALK_LANGUAGE": labels.Language, "notice": labels.Notice} {
			trayCall("SetWindowTextW", textControls[key], wide(text))
		}
		for key, text := range map[string]string{"PAWTALK_E2EE": labels.E2EE, "PAWTALK_SERVER_AUTO_UPDATE": labels.ServerUpdate, "PAWTALK_MANAGER_AUTO_UPDATE": labels.ManagerUpdate} {
			trayCall("SetWindowTextW", controls[key], wide(text))
		}
		trayCall("SetWindowTextW", apply, wide(labels.Apply))
		trayCall("SetWindowTextW", cancel, wide(labels.Cancel))
	}
	submit = func(request *settingsRequest, languageOnly bool) {
		busy = true
		trayCall("EnableWindow", apply, 0)
		trayCall("EnableWindow", cancel, 0)
		for _, control := range controls {
			trayCall("EnableWindow", control, 0)
		}
		trayCall("SetWindowTextW", apply, wide(labels.Busy))
		go func() {
			updated, err := backend(request)
			finished <- outcome{updated, err, languageOnly}
			trayCall("PostMessageW", window, 0x8006, 0, 0)
		}()
	}
	trayCall("EnableWindow", controls["PAWTALK_E2EE_KEY_ID"], trayCall("SendMessageW", controls["PAWTALK_E2EE"], 0xf0, 0, 0))
	trayCall("ShowWindow", window, 5)
	trayCall("ShowWindow", window, 5) // Also override an inherited STARTUPINFO SW_HIDE.
	trayCall("SetForegroundWindow", window)
	trayCall("SetFocus", controls["PAWTALK_PUBLIC_IP"])
	var message trayMessage
	for {
		result := int32(trayCall("GetMessageW", unsafe.Pointer(&message), 0, 0, 0))
		if result == -1 {
			return errors.New("settings message loop failed")
		}
		if result == 0 {
			return nil
		}
		if trayCall("IsDialogMessageW", window, unsafe.Pointer(&message)) == 0 {
			trayCall("TranslateMessage", unsafe.Pointer(&message))
			trayCall("DispatchMessageW", unsafe.Pointer(&message))
		}
	}
}
