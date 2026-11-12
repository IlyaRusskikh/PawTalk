//go:build windows

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

var brokerTokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func desktopBroker(pipe, token, root string) error {
	if !windows.GetCurrentProcessToken().IsElevated() || !strings.HasPrefix(pipe, `\\.\pipe\PawTalk.Manager.Broker.`) || !brokerTokenPattern.MatchString(strings.TrimPrefix(pipe, `\\.\pipe\PawTalk.Manager.Broker.`)) || !brokerTokenPattern.MatchString(token) {
		return errors.New("invalid privileged desktop session")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	connection, err := os.OpenFile(pipe, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer connection.Close()
	encoder := json.NewEncoder(connection)
	if err = encoder.Encode(map[string]string{"token": token}); err != nil {
		return err
	}
	scanner := bufio.NewScanner(connection)
	scanner.Buffer(make([]byte, 4096), 131072)
	for scanner.Scan() {
		var request struct {
			ID      int             `json:"id"`
			Action  string          `json:"action"`
			Payload json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || request.ID <= 0 {
			return errors.New("invalid desktop request")
		}
		result := map[string]any{"id": request.ID}
		if request.Action == "start" || request.Action == "stop" {
			if err = control(request.Action+"-server", root); err != nil {
				result["error"] = "service"
			} else {
				result["value"] = true
			}
		} else {
			allowed := map[string]bool{"snapshot": true, "apply": true, "invitation": true, "reset-password": true, "backup-create": true, "backup-restore": true, "diagnostics": true, "logs": true, "check-updates": true, "install-manager-update": true, "install-server-update": true}
			if !allowed[request.Action] {
				result["error"] = "invalid"
			} else {
				ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
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
		if err = encoder.Encode(result); err != nil {
			return err
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

func launchDesktop(root, lang string, settings bool) error {
	args := []string{"--root", root, "--lang", lang}
	if settings {
		args = append(args, "--settings")
	} else {
		args = append(args, "--tray")
	}
	command := exec.Command(filepath.Join(base(), "desktop", "PawTalk Server Manager.exe"), args...)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
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
