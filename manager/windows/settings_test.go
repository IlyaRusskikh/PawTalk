//go:build windows

package main

import (
	"encoding/json"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func settingsFixture() map[string]string {
	return map[string]string{
		"PAWTALK_PUBLIC_IP": "192.0.2.10", "PAWTALK_PORT": "18443", "PAWTALK_E2EE": "true",
		"PAWTALK_E2EE_KEY_ID": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"PAWTALK_CHAT_MAX_MB": "128", "PAWTALK_SERVER_AUTO_UPDATE": "true", "PAWTALK_MANAGER_AUTO_UPDATE": "false", "PAWTALK_LANGUAGE": "ru", "PAWTALK_BACKUP_KEEP": "5", "PAWTALK_UPDATE_PROXY": "true",
	}
}
func TestSettingsWindowHelper(t *testing.T) {
	root := os.Getenv("PAWTALK_SETTINGS_TEST_ROOT")
	if root == "" {
		return
	}
	values := settingsFixture()
	backend := func(request *settingsRequest) (map[string]string, error) {
		if request != nil {
			raw, _ := json.Marshal(request)
			if err := os.WriteFile(filepath.Join(root, "request.json"), raw, 0600); err != nil {
				return nil, err
			}
			for key, value := range request.Values {
				values[key] = value
			}
		}
		return values, nil
	}
	if err := showSettings(root, os.Getenv("PAWTALK_SETTINGS_TEST_LANG"), backend); err != nil {
		t.Fatal(err)
	}
}

type settingsRect struct{ Left, Top, Right, Bottom int32 }

func nativeRect(window uintptr) settingsRect {
	var rect settingsRect
	trayCall("GetWindowRect", window, unsafe.Pointer(&rect))
	return rect
}
func nativeControlText(window uintptr) string {
	var value [4096]uint16
	trayCall("SendMessageW", window, 0xd, len(value), unsafe.Pointer(&value[0]))
	return windows.UTF16ToString(value[:])
}
func waitSettingsWindow(t *testing.T, class, title string) uintptr {
	t.Helper()
	for until := time.Now().Add(10 * time.Second); time.Now().Before(until); time.Sleep(30 * time.Millisecond) {
		window := trayCall("FindWindowW", wide(class), wide(title))
		if window != 0 && trayCall("IsWindowVisible", window) != 0 {
			return window
		}
	}
	t.Fatal("native settings window did not appear", class, title)
	return 0
}
func TestNativeSettingsWindow(t *testing.T) {
	for _, lang := range []string{"ru", "en"} {
		t.Run(lang, func(t *testing.T) {
			root := t.TempDir()
			labels := settingsText(lang)
			start := func() (*exec.Cmd, uintptr) {
				child := exec.Command(executable(), "-test.run=^TestSettingsWindowHelper$")
				child.Env = append(os.Environ(), "PAWTALK_SETTINGS_TEST_ROOT="+root, "PAWTALK_SETTINGS_TEST_LANG="+lang)
				if err := child.Start(); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = child.Process.Kill() })
				window := waitSettingsWindow(t, settingsClass(root), labels.Title)
				for until := time.Now().Add(5 * time.Second); time.Now().Before(until); time.Sleep(20 * time.Millisecond) {
					if trayCall("GetDlgItem", window, 2) != 0 {
						return child, window
					}
				}
				t.Fatal("settings fields did not initialize")
				return nil, 0
			}
			child, window := start()
			control := func(id int) uintptr { return trayCall("GetDlgItem", window, id) }
			if nativeControlText(control(101)) != "192.0.2.10" || nativeControlText(control(102)) != "18443" || nativeControlText(control(105)) != "128" {
				t.Fatal("settings did not load existing values")
			}
			for _, id := range []int{101, 102, 103, 104, 105, 106, 107, 108, 1, 2} {
				if control(id) == 0 {
					t.Fatal("missing installer field", id)
				}
			}
			a, b := nativeRect(control(1)), nativeRect(control(2))
			if a.Bottom-a.Top != b.Bottom-b.Top || a.Top+a.Bottom != b.Top+b.Bottom {
				t.Fatal("native action buttons are misaligned")
			}
			previous := nativeRect(control(101))
			for _, id := range []int{102, 103, 104, 105, 106, 107, 108} {
				current := nativeRect(control(id))
				if current.Top < previous.Bottom {
					t.Fatal("overlapping fields", id)
				}
				previous = current
			}
			if trayCall("IsWindowEnabled", control(104)) == 0 {
				t.Fatal("enabled E2EE key field disabled")
			}
			trayCall("SendMessageW", control(103), 0xf5, 0, 0)
			if trayCall("IsWindowEnabled", control(104)) != 0 {
				t.Fatal("unchecked E2EE key field still enabled")
			}
			trayCall("SendMessageW", control(103), 0xf5, 0, 0)
			if trayCall("IsWindowEnabled", control(104)) == 0 {
				t.Fatal("E2EE key did not re-enable")
			}
			if err := captureSettings(window, filepath.Join("..", "..", "release", "qa", "server-settings-"+lang+".png")); err != nil {
				t.Fatal(err)
			}
			if err := closeTray(root); err != nil {
				t.Fatal("installer maintenance did not close settings", err)
			}
			if err := child.Wait(); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(root, "request.json")); !os.IsNotExist(err) {
				t.Fatal("closing settings saved changes")
			}
			child, window = start()
			trayCall("SendMessageW", control(101), 0xc, 0, wide("198.51.100.20"))
			trayCall("SendMessageW", control(102), 0xc, 0, wide("19443"))
			trayCall("SendMessageW", control(105), 0xc, 0, wide("64"))
			trayCall("SendMessageW", control(106), 0xf5, 0, 0)
			trayCall("SendMessageW", control(107), 0xf5, 0, 0)
			trayCall("PostMessageW", window, 0x111, 1, 0)
			confirm := waitSettingsWindow(t, "#32770", labels.Title)
			trayCall("PostMessageW", trayCall("GetDlgItem", confirm, 6), 0xf5, 0, 0)
			for until := time.Now().Add(10 * time.Second); time.Now().Before(until); time.Sleep(25 * time.Millisecond) {
				if _, err := os.Stat(filepath.Join(root, "request.json")); err == nil {
					break
				}
			}
			raw, err := os.ReadFile(filepath.Join(root, "request.json"))
			if err != nil {
				t.Fatal("settings were not submitted", err)
			}
			var request settingsRequest
			if json.Unmarshal(raw, &request) != nil {
				t.Fatal("invalid native settings protocol")
			}
			if request.Values["PAWTALK_PUBLIC_IP"] != "198.51.100.20" || request.Values["PAWTALK_PORT"] != "19443" || request.Values["PAWTALK_CHAT_MAX_MB"] != "64" || request.Values["PAWTALK_SERVER_AUTO_UPDATE"] != "false" || request.Values["PAWTALK_MANAGER_AUTO_UPDATE"] != "true" || request.Expected["PAWTALK_PORT"] != "18443" {
				t.Fatal("settings window submitted wrong values")
			}
			success := waitSettingsWindow(t, "#32770", labels.Title)
			trayCall("PostMessageW", trayCall("GetDlgItem", success, 1), 0xf5, 0, 0)
			trayCall("PostMessageW", window, 0x10, 0, 0)
			done := make(chan error, 1)
			go func() { done <- child.Wait() }()
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("settings window failed to close")
			}
		})
	}
}

// Print only the test window, never the user's desktop, for visual QA.
func captureSettings(window uintptr, file string) error {
	rect := nativeRect(window)
	width, height := int(rect.Right-rect.Left), int(rect.Bottom-rect.Top)
	gdi := windows.NewLazySystemDLL("gdi32.dll")
	call := func(name string, args ...uintptr) uintptr {
		value, _, _ := gdi.NewProc(name).Call(args...)
		return value
	}
	dc := trayCall("GetWindowDC", window)
	defer trayCall("ReleaseDC", window, dc)
	memory := call("CreateCompatibleDC", dc)
	defer call("DeleteDC", memory)
	bitmap := call("CreateCompatibleBitmap", dc, uintptr(width), uintptr(height))
	defer call("DeleteObject", bitmap)
	old := call("SelectObject", memory, bitmap)
	trayCall("PrintWindow", window, memory, 0)
	call("SelectObject", memory, old)
	header := struct {
		Size                   uint32
		Width, Height          int32
		Planes, Bits           uint16
		Compression, ImageSize uint32
		X, Y                   int32
		Used, Important        uint32
	}{Size: 40, Width: int32(width), Height: -int32(height), Planes: 1, Bits: 32}
	pixels := make([]byte, width*height*4)
	call("GetDIBits", dc, bitmap, 0, uintptr(height), uintptr(unsafe.Pointer(&pixels[0])), uintptr(unsafe.Pointer(&header)), 0)
	for i := 0; i < len(pixels); i += 4 {
		pixels[i], pixels[i+2], pixels[i+3] = pixels[i+2], pixels[i], 255
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	out, err := os.Create(file)
	if err != nil {
		return err
	}
	defer out.Close()
	return png.Encode(out, &image.NRGBA{Pix: pixels, Stride: width * 4, Rect: image.Rect(0, 0, width, height)})
}
