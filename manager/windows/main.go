//go:build windows

// Stable Windows launcher/SCM protocol 1. Policy lives in the shared Manager.
package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
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
	"golang.org/x/sys/windows/svc/mgr"
)

var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$`)

func executable() string {
	p, e := os.Executable()
	if e != nil {
		panic(e)
	}
	p, e = filepath.Abs(p)
	if e != nil {
		panic(e)
	}
	return p
}
func base() string { return filepath.Dir(executable()) }
func defaultRoot() string {
	programData, e := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if e != nil {
		panic(e)
	}
	return filepath.Join(programData, "PawTalk")
}
func serviceName(kind, root string) string {
	hash := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(root))))
	return "PawTalk" + map[string]string{"server": "Server", "manager": "Manager"}[kind] + "-" + hex.EncodeToString(hash[:4])
}

func pointer(root, name string) (string, error) {
	data, e := os.ReadFile(filepath.Join(root, "opt", "pawtalk-manager", name+".json"))
	if e != nil {
		return "", e
	}
	var p struct {
		Version string `json:"version"`
	}
	if e = json.Unmarshal(data, &p); e != nil {
		return "", e
	}
	if !versionPattern.MatchString(p.Version) {
		return "", errors.New("invalid Manager pointer")
	}
	return filepath.Join(root, "opt", "pawtalk-manager", "versions", p.Version, "manager", "pawtalkctl"), nil
}

func python(ctx context.Context, script string, args ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, filepath.Join(base(), "runtime", "python.exe"), append([]string{"-B", "-X", "utf8", "-I", script}, args...)...)
	// The GUI tray is not the host protocol executable. Python must always call
	// the companion console host for protection, DPAPI and service commands.
	command.Env = append(os.Environ(), "PAWTALK_MANAGER_HOST="+filepath.Join(base(), "pawtalkctl.exe"), "PYTHONUTF8=1", "PYTHONDONTWRITEBYTECODE=1")
	// Console output still follows the host's pipes/terminal, but the embedded
	// runtime must never create an additional installer console window.
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return command
}

func selected(root string) (string, error) {
	script, e := pointer(root, "current")
	if os.IsNotExist(e) {
		if _, err := os.Stat(filepath.Join(root, "var", "lib", "pawtalk-manager", "installed.json")); os.IsNotExist(err) {
			return filepath.Join(base(), "bootstrap", "manager", "pawtalkctl"), nil
		}
	}
	if e == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		output, err := python(ctx, script, "--self-test").Output()
		if err == nil && strings.TrimSpace(string(output)) == "PawTalk manager protocol 1 OK" {
			return script, nil
		}
	}
	previous, err := pointer(root, "previous")
	if err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		output, check := python(ctx, previous, "--self-test").Output()
		if check == nil && strings.TrimSpace(string(output)) == "PawTalk manager protocol 1 OK" {
			directory := filepath.Join(root, "opt", "pawtalk-manager")
			data, readErr := os.ReadFile(filepath.Join(directory, "previous.json"))
			if readErr == nil {
				_ = os.WriteFile(filepath.Join(directory, ".fallback.json"), data, 0600)
				_ = os.Rename(filepath.Join(directory, ".fallback.json"), filepath.Join(directory, "current.json"))
			}
		}
	}
	return "", errors.New("Manager unavailable; attempted fallback, operation cancelled; server remains independent")
}

func launch(ctx context.Context, root string, args []string, job windows.Handle, stdio bool) error {
	var script string
	var e error
	// The native installer's Windows setup/credential UX comes from its shipped
	// bootstrap. Signed Manager releases still drive periodic maintenance.
	if bootstrapCommand(args) {
		script, e = filepath.Join(base(), "bootstrap", "manager", "pawtalkctl"), nil
	} else {
		script, e = selected(root)
	}
	if e != nil {
		return e
	}
	command := python(ctx, script, append([]string{"--root", root}, args...)...)
	if stdio {
		command.Stdin = os.Stdin
		command.Stdout = os.Stdout
		command.Stderr = os.Stderr
	}
	if !stdio {
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	}
	if e = command.Start(); e != nil {
		return e
	}
	if job != 0 {
		process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(command.Process.Pid))
		if err == nil {
			err = windows.AssignProcessToJobObject(job, process)
			windows.CloseHandle(process)
		}
		if err != nil {
			_ = command.Process.Kill()
			_ = command.Wait()
			return err
		}
	}
	return command.Wait()
}

type service struct{ kind, root string }

func (s *service) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending, WaitHint: 30000}
	job, e := windows.CreateJobObject(nil, nil)
	if e != nil {
		return false, 1
	}
	defer windows.CloseHandle(job)
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, e = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); e != nil {
		return false, 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopFile := filepath.Join(s.root, "var", "log", "pawtalk", "stop-server")
	if s.kind == "server" {
		_ = os.Remove(stopFile)
	}
	done := make(chan error, 1)
	go func() {
		if s.kind == "server" {
			done <- launch(ctx, s.root, []string{"run-server"}, job, false)
			return
		}
		updates := time.NewTicker(10 * time.Minute)
		defer updates.Stop()
		health := time.NewTicker(time.Minute)
		defer health.Stop()
		_ = launch(ctx, s.root, []string{"health"}, job, false)
		for {
			select {
			case <-ctx.Done():
				done <- nil
				return
			case <-updates.C:
				_ = launch(ctx, s.root, []string{"periodic"}, job, false)
			case <-health.C:
				_ = launch(ctx, s.root, []string{"health"}, job, false)
			}
		}
	}()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case <-done:
			return false, 1
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending, WaitHint: 30000}
				if s.kind == "server" {
					_ = os.WriteFile(stopFile, []byte("stop"), 0600)
				} else {
					cancel()
				}
				select {
				case <-done:
				case <-time.After(20 * time.Second):
					cancel()
				}
				return false, 0
			}
		}
	}
}

func control(action, root string) error {
	pieces := strings.SplitN(action, "-", 2)
	if len(pieces) != 2 || (pieces[1] != "server" && pieces[1] != "manager") {
		return errors.New("invalid service operation")
	}
	kind := pieces[1]
	if pieces[0] == "install" {
		programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
		if err != nil {
			return err
		}
		absolute, err := filepath.Abs(root)
		if err != nil {
			return err
		}
		if !strings.EqualFold(filepath.Dir(absolute), programData) {
			return errors.New("service data root must be a direct child of protected ProgramData")
		}
	}
	name := serviceName(kind, root)
	connection, e := mgr.Connect()
	if e != nil {
		return e
	}
	defer connection.Disconnect()
	s, e := connection.OpenService(name)
	if pieces[0] == "install" {
		if e == nil {
			defer s.Close()
			cfg, err := s.Config()
			if err != nil {
				return err
			}
			if !strings.HasPrefix(strings.ToLower(cfg.BinaryPathName), strings.ToLower(syscall.EscapeArg(executable())+" --service ")) {
				return errors.New("service ownership mismatch")
			}
			return nil
		}
		if !errors.Is(e, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return e
		}
		account := ""
		if kind == "server" {
			account = "NT AUTHORITY\\LocalService"
		}
		s, e = connection.CreateService(name, executable(), mgr.Config{StartType: mgr.StartAutomatic, ServiceStartName: account, DisplayName: "PawTalk " + kind, Description: "PawTalk permanent server / maintenance"}, "--service", kind, root)
		if e != nil {
			return e
		}
		defer s.Close()
		if e = s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 10 * time.Second}, {Type: mgr.ServiceRestart, Delay: 30 * time.Second}, {Type: mgr.ServiceRestart, Delay: time.Minute}}, 86400); e != nil {
			return e
		}
		return s.SetRecoveryActionsOnNonCrashFailures(true)
	}
	if errors.Is(e, windows.ERROR_SERVICE_DOES_NOT_EXIST) && (pieces[0] == "uninstall" || pieces[0] == "stop") {
		return nil
	}
	if errors.Is(e, windows.ERROR_SERVICE_MARKED_FOR_DELETE) && (pieces[0] == "uninstall" || pieces[0] == "stop") {
		return awaitServiceRemoval(connection, name)
	}
	if e != nil {
		return e
	}
	if pieces[0] == "uninstall" {
		err := s.Delete()
		_ = s.Close() // Holding our handle itself prevents SCM from removing it.
		if err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			return err
		}
		return awaitServiceRemoval(connection, name)
	}
	defer s.Close()
	switch pieces[0] {
	case "status":
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Running {
			return errors.New("service stopped")
		}
		return nil
	case "start":
		if err := windows.ChangeServiceConfig(s.Handle, windows.SERVICE_NO_CHANGE, windows.SERVICE_AUTO_START, windows.SERVICE_NO_CHANGE, nil, nil, nil, nil, nil, nil, nil); err != nil {
			return err
		}
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State == svc.Running || status.State == svc.StartPending {
			return nil
		}
		return s.Start()
	case "stop":
		// SCM cannot cancel queued recovery actions. Disable before a consistent
		// backup/restore, then re-enable only when start is explicitly requested.
		if err := windows.ChangeServiceConfig(s.Handle, windows.SERVICE_NO_CHANGE, windows.SERVICE_DISABLED, windows.SERVICE_NO_CHANGE, nil, nil, nil, nil, nil, nil, nil); err != nil {
			return err
		}
		// SERVICE_STOPPED may precede process teardown. Wait for the old host
		// to release Python/runtime files before a reinstall replaces its tree.
		var process *serviceProcess
		defer func() {
			if process != nil {
				process.close()
			}
		}()
		query := func() (svc.Status, error) {
			status, err := s.Query()
			if err == nil && process == nil && status.ProcessId != 0 {
				process, err = observeServiceProcess(status.ProcessId)
			}
			return status, err
		}
		if err := waitServiceStopped(query, func() error { _, err := s.Control(svc.Stop); return err }, 40*time.Second); err != nil {
			return err
		}
		if process == nil {
			return nil
		}
		return process.wait(10 * time.Second)
	}
	return errors.New("unknown service action")
}

func waitServiceStopped(query func() (svc.Status, error), stop func() error, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	requested := false
	for {
		status, err := query()
		if err != nil {
			return err
		}
		if status.State == svc.Stopped {
			return nil
		}
		// SCM rejects controls during startup and pending transitions. A freshly
		// started legacy service must reach an accepting state before migration.
		if !requested && (status.State == svc.Running || status.State == svc.Paused) && status.Accepts&svc.AcceptStop != 0 {
			err = stop()
			if err == nil {
				requested = true
			} else if !errors.Is(err, windows.ERROR_SERVICE_CANNOT_ACCEPT_CTRL) && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
				return err
			}
		}
		if !time.Now().Before(deadline) {
			return errors.New("service stop timed out")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func awaitServiceRemoval(connection *mgr.Mgr, name string) error {
	return waitServiceGone(func() error {
		service, err := connection.OpenService(name)
		if err == nil {
			_ = service.Close()
		}
		return err
	}, 40*time.Second)
}

func waitServiceGone(probe func() error, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		err := probe()
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil
		}
		if err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
			return err
		}
		if time.Now().After(deadline) {
			return errors.New("service deletion timed out")
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func verify(args []string) error {
	if len(args) != 0 {
		return errors.New("verification uses a private stdin pipe")
	}
	var value struct {
		PublicKey string
		Payload   []byte
		Signature []byte
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 65537))
	decoder.DisallowUnknownFields()
	if e := decoder.Decode(&value); e != nil {
		return e
	}
	var extra any
	if e := decoder.Decode(&extra); e != io.EOF {
		return errors.New("trailing verification data")
	}
	if len(value.PublicKey) > 8192 || len(value.Payload) > 16384 || len(value.Signature) != ed25519.SignatureSize {
		return errors.New("invalid verification input")
	}
	block, _ := pem.Decode([]byte(value.PublicKey))
	if block == nil {
		return errors.New("invalid public key")
	}
	public, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return e
	}
	ed, ok := public.(ed25519.PublicKey)
	if !ok {
		return errors.New("Ed25519 required")
	}
	if !ed25519.Verify(ed, value.Payload, value.Signature) {
		return errors.New("invalid signature")
	}
	return nil
}

func main() {
	if isTrayExecutable() {
		os.Exit(trayMain(os.Args[1:]))
	}
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--elevate" {
		quoted := make([]string, 0, len(args)-1)
		for _, arg := range args[1:] {
			quoted = append(quoted, syscall.EscapeArg(arg))
		}
		verb, _ := windows.UTF16PtrFromString("runas")
		file, _ := windows.UTF16PtrFromString(executable())
		parameters, _ := windows.UTF16PtrFromString(strings.Join(quoted, " "))
		if e := windows.ShellExecute(0, verb, file, parameters, nil, windows.SW_SHOWNORMAL); e != nil {
			fmt.Fprintln(os.Stderr, "Unable to elevate Manager:", e)
			os.Exit(1)
		}
		return
	}
	pause := len(args) > 0 && args[0] == "--pause"
	if pause {
		args = args[1:]
	}
	var err error
	if len(args) > 0 && args[0] == "verify" {
		err = verify(args[1:])
	} else if len(args) == 1 && (args[0] == "seal-credential" || args[0] == "unseal-credential") {
		err = credentialCommand(args[0] == "unseal-credential")
	} else if len(args) == 2 && args[0] == "validate-install-removal" {
		err = validateInstallRemoval(args[1])
	} else if len(args) == 2 && args[0] == "purge-data" {
		err = purgeData(args[1])
	} else if len(args) == 2 && args[0] == "uninstall-services" {
		err = uninstallServices(args[1])
	} else if len(args) == 2 && args[0] == "protect" {
		err = protectRoot(args[1])
	} else if len(args) == 2 && args[0] == "close-tray" {
		err = closeTray(args[1])
	} else if len(args) == 2 && args[0] == "protect-install" {
		err = protectInstall(args[1])
	} else if len(args) == 2 && args[0] == "secure-tree" {
		err = secureTree(args[1])
	} else if len(args) == 3 && args[0] == "--console-service" && (args[1] == "server" || args[1] == "manager") {
		requests := make(chan svc.ChangeRequest, 1)
		status := make(chan svc.Status, 8)
		done := make(chan uint32, 1)
		go func() { _, code := (&service{args[1], args[2]}).Execute(nil, requests, status); done <- code }()
		go func() { _, _ = bufio.NewReader(os.Stdin).ReadByte(); requests <- svc.ChangeRequest{Cmd: svc.Stop} }()
		if code := <-done; code != 0 {
			err = errors.New("foreground service exited")
		}
	} else if len(args) == 3 && args[0] == "--service" {
		err = svc.Run(serviceName(args[1], args[2]), &service{args[1], args[2]})
	} else if len(args) == 2 && (strings.HasSuffix(args[0], "-server") || strings.HasSuffix(args[0], "-manager")) {
		err = control(args[0], args[1])
	} else {
		root := defaultRoot()
		if len(args) >= 2 && args[0] == "--root" {
			root = args[1]
			args = args[2:]
		}
		err = launch(context.Background(), root, args, 0, true)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "PawTalk operation failed:", err)
	}
	if pause {
		fmt.Print("Press Enter to close / Нажмите Enter для закрытия: ")
		_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	}
	if err != nil {
		os.Exit(1)
	}
}
