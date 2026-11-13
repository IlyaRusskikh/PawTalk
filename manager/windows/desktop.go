//go:build windows

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

var brokerTokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Deliberately typed: private configuration and credentials cannot be published.
type desktopPublicStatus struct {
	Update struct {
		Status    string  `json:"status"`
		Version   *string `json:"version,omitempty"`
		CheckedAt int64   `json:"checkedAt,omitempty"`
	} `json:"update"`
	Language       string `json:"language"`
	AutoManager    bool   `json:"autoManager"`
	ServerVersion  string `json:"serverVersion"`
	ManagerVersion string `json:"managerVersion"`
}

func decodeDesktopStatus(input io.Reader) (desktopPublicStatus, error) {
	var value desktopPublicStatus
	data, err := io.ReadAll(io.LimitReader(input, 4097))
	if err != nil {
		return value, err
	}
	if len(data) > 4096 {
		return value, errors.New("public status document too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return value, errors.New("invalid public status document")
	}
	allowed := map[string]bool{"idle": true, "available": true, "current": true, "installing": true, "check-failed": true}
	if !allowed[value.Update.Status] || (value.Language != "ru" && value.Language != "en") || !versionPattern.MatchString(value.ServerVersion) || !versionPattern.MatchString(value.ManagerVersion) || (value.Update.Version != nil && !versionPattern.MatchString(*value.Update.Version)) {
		return value, errors.New("invalid public status values")
	}
	return value, nil
}

func publishDesktopStatus(root string, input io.Reader) error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("administrator required")
	}
	value, err := decodeDesktopStatus(input)
	if err != nil {
		return err
	}
	if err = noLinks(base()); err != nil {
		return err
	}
	marker, err := os.ReadFile(filepath.Join(base(), ".pawtalk-manager-install"))
	if err != nil {
		return err
	}
	if string(marker) != "pawtalk-manager-install-v1" {
		return errors.New("unowned Manager installation")
	}
	file, err := os.CreateTemp(base(), ".desktop-status-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	// Set the public read-only ACL before replacing the published document.
	err = applySecurity(file.Name(), "GRGX", true)
	if err == nil {
		err = json.NewEncoder(file).Encode(value)
	}
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
	name := "status-" + strings.TrimPrefix(serverTrayClass(root), "PawTalk.Server.Tray.") + ".json"
	return os.Rename(file.Name(), filepath.Join(base(), name))
}

func desktopBroker(pipe, token, root string) error {
	if !windows.GetCurrentProcessToken().IsElevated() || !strings.HasPrefix(pipe, `\\.\pipe\PawTalk.Manager.Broker.`) || !brokerTokenPattern.MatchString(strings.TrimPrefix(pipe, `\\.\pipe\PawTalk.Manager.Broker.`)) || !brokerTokenPattern.MatchString(token) {
		return errors.New("invalid privileged desktop session")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	// A synchronous Windows pipe serializes I/O on its handle: the scanner's
	// next read would prevent a concurrent metadata worker from writing back.
	handle, err := windows.CreateFile(wide(pipe), windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return err
	}
	connection := os.NewFile(uintptr(handle), pipe)
	defer connection.Close()
	encoder := json.NewEncoder(connection)
	if err = encoder.Encode(map[string]string{"token": token}); err != nil {
		return err
	}
	scanner := bufio.NewScanner(connection)
	scanner.Buffer(make([]byte, 4096), 131072)
	session, cancelSession := context.WithCancel(context.Background())
	defer cancelSession()
	var writing sync.Mutex
	for scanner.Scan() {
		var request struct {
			ID      int             `json:"id"`
			Action  string          `json:"action"`
			Payload json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.ID <= 0 {
			return errors.New("invalid desktop request")
		}
		handle := func() {
			result := map[string]any{"id": request.ID}
			if request.Action == "start" || request.Action == "stop" {
				if control(request.Action+"-server", root) != nil {
					result["error"] = "service"
				} else {
					result["value"] = true
				}
			} else {
				allowed := map[string]bool{"snapshot": true, "apply": true, "invitation": true, "reset-password": true, "backup-create": true, "backup-restore": true, "backup-delete": true, "diagnostics": true, "logs": true, "check-updates": true, "check-server-updates": true, "install-manager-update": true, "install-server-update": true, "inspect-server-package": true, "install-server-package": true}
				if !allowed[request.Action] {
					result["error"] = "invalid"
				} else {
					limit := 180 * time.Second
					if request.Action == "check-updates" || request.Action == "check-server-updates" {
						limit = 25 * time.Second
					}
					ctx, cancel := context.WithTimeout(session, limit)
					command := python(ctx, filepath.Join(base(), "bootstrap", "manager", "pawtalkctl"), "--root", root, "desktop", request.Action)
					command.Stdin = bytes.NewReader(request.Payload)
					output, runErr := command.Output()
					timedOut := ctx.Err() != nil
					cancel()
					var response map[string]any
					if timedOut {
						result["error"] = "timeout"
					} else if len(output) > 1024*1024 || json.Unmarshal(output, &response) != nil {
						result["error"] = "failed"
					} else if response["error"] != nil {
						result["error"] = response["error"]
					} else if runErr != nil {
						result["error"] = "failed"
					} else {
						result["value"] = response["value"]
					}
				}
			}
			writing.Lock()
			defer writing.Unlock()
			if encoder.Encode(result) != nil {
				_ = connection.Close()
			}
		}
		if request.Action == "check-updates" || request.Action == "check-server-updates" {
			go handle()
		} else {
			handle()
		}
	}
	return scanner.Err()
}

func desktopStatus(root string) map[string]any {
	state, err := trayState(root)
	names := map[svc.State]string{svc.Stopped: "stopped", svc.StartPending: "starting", svc.StopPending: "stopping", svc.Running: "running", svc.ContinuePending: "starting", svc.PausePending: "stopping", svc.Paused: "stopped"}
	label := names[state]
	if err != nil || label == "" {
		label = "unavailable"
	}
	return map[string]any{"state": label}
}

func desktopControlPipe(root string) string {
	return `\\.\pipe\PawTalk.Manager.UI.` + strings.TrimPrefix(serverTrayClass(root), "PawTalk.Server.Tray.")
}

func closeDesktop(root string, restart bool) error {
	connection, err := os.OpenFile(desktopControlPipe(root), os.O_RDWR, 0)
	if os.IsNotExist(err) || errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return nil
	}
	if err != nil {
		return err
	}
	defer connection.Close()
	timer := time.AfterFunc(210*time.Second, func() { _ = connection.Close() })
	defer timer.Stop()
	if err = json.NewEncoder(connection).Encode(map[string]any{"action": "maintenance", "restart": restart}); err != nil {
		return err
	}
	var response struct {
		OK bool `json:"ok"`
	}
	if err = json.NewDecoder(connection).Decode(&response); err != nil {
		return err
	}
	if !response.OK {
		return errors.New("desktop maintenance close failed")
	}
	return nil
}

func desktopLaunchCommand(root, lang string, settings bool) *exec.Cmd {
	args := []string{"--root", root, "--lang", lang}
	if settings {
		args = append(args, "--settings")
	} else {
		args = append(args, "--tray")
	}
	command := exec.Command(filepath.Join(base(), "desktop", "PawTalk Server Manager.exe"), args...)
	// CREATE_NO_WINDOW suppresses a console without setting STARTF_USESHOWWINDOW
	// to SW_HIDE. That startup override consumes Electron's first window.show().
	// The GUI itself stays hidden in tray mode through BrowserWindow.show=false.
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	return command
}

func launchDesktop(root, lang string, settings bool) error {
	command := desktopLaunchCommand(root, lang, settings)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func desktopCheckEvent(root string) string {
	return `Global\PawTalk.Manager.Check.` + strings.TrimPrefix(serverTrayClass(root), "PawTalk.Server.Tray.")
}
func signalDesktopCheck(root string) bool {
	event, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, wide(desktopCheckEvent(root)))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(event)
	return windows.SetEvent(event) == nil
}
func desktopCheckRequests(ctx context.Context, root string) <-chan struct{} {
	requests := make(chan struct{}, 1)
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x0002;;;BU)")
	if err != nil {
		return requests
	}
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	event, err := windows.CreateEvent(&attributes, 0, 0, wide(desktopCheckEvent(root)))
	if err != nil {
		return requests
	}
	go func() {
		defer windows.CloseHandle(event)
		for {
			if ctx.Err() != nil {
				return
			}
			result, err := windows.WaitForSingleObject(event, 1000)
			if err != nil {
				return
			}
			if result == windows.WAIT_OBJECT_0 {
				select {
				case requests <- struct{}{}:
				default:
				}
			}
		}
	}()
	return requests
}
