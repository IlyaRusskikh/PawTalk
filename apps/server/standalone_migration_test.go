package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func checkStandaloneProtectedStartup(t *testing.T, ctx context.Context, dir string, activation protectedActivation) {
	t.Helper()
	executable := standaloneMigrationLiveKit(t)
	state, err := readState(dir)
	if err != nil {
		t.Fatal(err)
	}
	port := reserveProtectedStartupPort(t)
	checkStandaloneProtectedPort(t, ctx, dir, state, port, executable, activation)
}

func standaloneMigrationLiveKit(t *testing.T) string {
	t.Helper()
	executable := os.Getenv("PAWTALK_LIVEKIT_EXECUTABLE")
	if executable == "" {
		executable = "/livekit-server"
		if runtime.GOOS == "windows" {
			var err error
			executable, err = filepath.Abs("../../resources/server/livekit-server.exe")
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := os.Stat(executable); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			t.Skip("standalone LiveKit binary unavailable for this platform")
		}
		t.Fatal(err)
	}
	return executable
}

func checkStandaloneProtectedPort(t *testing.T, ctx context.Context, dir string, state serverState, port int, executable string, activation protectedActivation) {
	t.Helper()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	process := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStandaloneMigrationModeServesOnlyMaintenance$")
	hideWindow(process)
	process.Env = append(os.Environ(), "PAWTALK_TEST_STANDALONE_MIGRATION_COMMAND=serve", "PAWTALK_DATA_DIR="+dir,
		"PAWTALK_PUBLIC_IP=127.0.0.1", fmt.Sprintf("PAWTALK_PORT=%d", port),
		"PAWTALK_LIVEKIT_EXECUTABLE="+executable, "PAWTALK_MANAGED_STDIN=true")
	var output bytes.Buffer
	process.Stdout, process.Stderr = &output, &output
	stdin, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var ended error
	go func() { ended = process.Wait(); close(done) }()
	defer func() { cancel(); <-done }()
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(state.Certificate)) {
		t.Fatal("missing protected server certificate")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second}
	base := fmt.Sprintf("https://127.0.0.1:%d", port)
	for {
		response, err := client.Get(base + "/api/v3/session/challenge")
		if err == nil {
			var challenge protectedSessionChallenge
			decodeErr := json.NewDecoder(response.Body).Decode(&challenge)
			response.Body.Close()
			if response.StatusCode != http.StatusOK || decodeErr != nil || challenge.Protocol != 3 ||
				challenge.ServerID != activation.ServerID || challenge.CutoverDigest != activation.CutoverDigest {
				t.Fatalf("standalone did not select the activated runtime: %+v, %v", challenge, decodeErr)
			}
			break
		}
		select {
		case <-done:
			t.Fatalf("standalone exited after activation: %v\n%s", ended, output.String())
		case <-time.After(25 * time.Millisecond):
		}
	}
	for route, expected := range map[string]int{"/healthz": 200, "/rtc/": 200, "/rtc/rtc": 401, "/api/v2/challenge": 404, migrationHealthPath: 404} {
		response, err := client.Get(base + route)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != expected {
			t.Fatalf("runtime route %s: %d", route, response.StatusCode)
		}
	}
	checkHealth := func(digest string) error {
		health := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStandaloneMigrationModeServesOnlyMaintenance$")
		hideWindow(health)
		health.Env = append(append([]string(nil), process.Env...), "PAWTALK_TEST_STANDALONE_MIGRATION_COMMAND=protected-healthcheck "+digest)
		return health.Run()
	}
	if err := checkHealth(activation.CutoverDigest); err != nil {
		t.Fatalf("Manager health command rejected active protected process: %v", err)
	}
	if err := checkHealth(strings.Repeat("0", 64)); err == nil {
		t.Fatal("Manager health command accepted another cutover fingerprint")
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	<-done
	if ended != nil {
		t.Fatalf("protected shutdown failed: %v\n%s", ended, output.String())
	}
}

func TestStandaloneAutomaticallyActivatesOnOwnerConfirmation(t *testing.T) {
	executable := standaloneMigrationLiveKit(t)
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node unavailable")
	}
	dir := t.TempDir()
	store, _, owner, admin, _, report := testMigrationHistoryHTTPSource(t, dir, "unprepared")
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	state, err := readState(dir)
	if err != nil {
		t.Fatal(err)
	}
	port := reserveProtectedStartupPort(t)
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Second)
	defer cancel()
	process := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStandaloneMigrationModeServesOnlyMaintenance$")
	hideWindow(process)
	process.Env = append(os.Environ(), "PAWTALK_TEST_STANDALONE_MIGRATION_COMMAND=serve", "PAWTALK_DATA_DIR="+dir,
		"PAWTALK_PUBLIC_IP=127.0.0.1", fmt.Sprintf("PAWTALK_PORT=%d", port),
		"PAWTALK_LIVEKIT_EXECUTABLE="+executable, "PAWTALK_MANAGED_STDIN=true", "PAWTALK_STANDALONE_AUTO_MIGRATION=true")
	var output bytes.Buffer
	process.Stdout, process.Stderr = &output, &output
	stdin, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- process.Wait() }()
	defer func() {
		_ = stdin.Close()
		if err := <-done; err != nil {
			t.Errorf("automatic standalone shutdown: %v\n%s", err, output.String())
		}
	}()
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM([]byte(state.Certificate))
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second}
	base := fmt.Sprintf("https://127.0.0.1:%d", port)
	for {
		response, err := client.Get(base + migrationHealthPath)
		if err == nil {
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("automatic migration did not wait for the owner: %d", response.StatusCode)
			}
			break
		}
		select {
		case <-time.After(25 * time.Millisecond):
		case <-ctx.Done():
			t.Fatalf("automatic migration did not start: %v", err)
		}
	}
	seeds := func(signer testMemberSigner) map[string]string {
		return map[string]string{"root": hex.EncodeToString(signer.root.Seed()), "device": hex.EncodeToString(signer.device.Seed())}
	}
	archiveSHA, err := migrationFileSHA256(filepath.Join(dir, standaloneMigrationBackup))
	if err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal(map[string]any{
		"base": base, "serverId": report.ServerID, "archiveSha256": archiveSHA,
		"legacySecret": migrationFixtureLegacySecret, "owner": seeds(owner), "admin": seeds(admin),
		"certificate": state.Certificate, "recipient": "automatic-standalone-live",
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := runMigrationClient(ctx, node, "../client/windows/scripts/protected-migration-history-integration.cjs", input)
	if err != nil {
		t.Fatalf("running standalone migration failed: %v\n%s", err, result)
	}
	var migrated struct{ CutoverDigest string }
	if err := json.Unmarshal(result, &migrated); err != nil || !validHexID(migrated.CutoverDigest, 64) {
		t.Fatalf("invalid activated server response: %v", err)
	}
	response, err := client.Get(base + "/api/v2/challenge")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("activated server serves legacy API: %d", response.StatusCode)
	}
}

func reserveProtectedStartupPort(t *testing.T) int {
	t.Helper()
	for range 64 {
		// A TLS fixture can leave a run of adjacent ephemeral ports in TIME_WAIT.
		port := 20_000 + rand.IntN(20_000)
		base, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		// LiveKit needs both companion TCP listeners and a separate UDP port.
		rtc, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port+1))
		if err != nil {
			base.Close()
			continue
		}
		media, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port+3))
		if err != nil {
			rtc.Close()
			base.Close()
			continue
		}
		udp, err := net.ListenPacket("udp4", fmt.Sprintf("0.0.0.0:%d", port+2))
		media.Close()
		rtc.Close()
		base.Close()
		if err == nil {
			udp.Close()
			return port
		}
	}
	t.Fatal("no available port group for PawTalk and LiveKit")
	return 0
}

func TestStandaloneMigrationModeServesOnlyMaintenance(t *testing.T) {
	const modeEnv = "PAWTALK_TEST_STANDALONE_MIGRATION_COMMAND"
	if mode := os.Getenv(modeEnv); mode != "" {
		var args []string
		if mode != "serve" {
			args = strings.Fields(mode)
		}
		if err := standalone(args); err != nil {
			t.Fatal(err)
		}
		return
	}

	dir := t.TempDir()
	store, _, owner, _, _, report := testMigrationHistoryHTTPSource(t, dir, "manual")
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	state, err := readState(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, membershipDatabaseFile)
	before, err := migrationFileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := reservation.Addr().(*net.TCPAddr).Port
	if err := reservation.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := func(mode string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestStandaloneMigrationModeServesOnlyMaintenance$")
		hideWindow(cmd)
		cmd.Env = append(os.Environ(), modeEnv+"="+mode, "PAWTALK_DATA_DIR="+dir,
			"PAWTALK_PUBLIC_IP=127.0.0.1", fmt.Sprintf("PAWTALK_PORT=%d", port),
			"PAWTALK_LIVEKIT_EXECUTABLE="+filepath.Join(dir, "absent-livekit"), "PAWTALK_MANAGED_STDIN=true")
		return cmd
	}
	process := command("serve")
	var log bytes.Buffer
	process.Stdout, process.Stderr = &log, &log
	stdin, err := process.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var processErr error
	go func() { processErr = process.Wait(); close(done) }()
	defer func() { cancel(); <-done }()
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(state.Certificate)) {
		t.Fatal("could not pin fixture certificate")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	base := fmt.Sprintf("https://127.0.0.1:%d", port)
	read := func(route string) (*http.Response, error) { return client.Get(base + route) }
	for {
		response, err := read(migrationHealthPath)
		if err == nil {
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("maintenance status = %d", response.StatusCode)
			}
			break
		}
		select {
		case <-done:
			t.Fatalf("standalone maintenance exited: %v\n%s", processErr, log.String())
		case <-time.After(25 * time.Millisecond):
		}
	}
	if output, err := command("healthcheck").CombinedOutput(); err != nil {
		t.Fatalf("healthcheck did not recognize maintenance: %v\n%s", err, output)
	}
	if output, err := command("migration-healthcheck " + report.BackupArchiveSHA256).CombinedOutput(); err != nil {
		t.Fatalf("checkpoint readiness did not confirm the active migration: %v\n%s", err, output)
	}
	wrongArchive := strings.Repeat("0", 64)
	if output, err := command("migration-healthcheck " + wrongArchive).CombinedOutput(); err == nil {
		t.Fatalf("checkpoint readiness accepted another archive: %s", output)
	}
	if output, err := command("migration-verify " + wrongArchive).CombinedOutput(); err == nil ||
		!strings.Contains(string(output), "does not match the expected migration checkpoint") {
		t.Fatalf("migration verification did not enforce the archive: %v\n%s", err, output)
	}
	if output, err := command("migration-verify " + report.BackupArchiveSHA256).CombinedOutput(); err == nil ||
		!strings.Contains(string(output), "MIGRATION_IMPORT_INCOMPLETE") {
		t.Fatalf("migration verification did not reject incomplete staging: %v\n%s", err, output)
	}
	probe, err := http.NewRequest(http.MethodGet, base+migrationHealthPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	probe.Header.Set(migrationCheckpointHeader, wrongArchive)
	wrongResponse, err := client.Do(probe)
	if err != nil {
		t.Fatal(err)
	}
	wrongResponse.Body.Close()
	if wrongResponse.StatusCode != http.StatusConflict {
		t.Fatalf("running maintenance accepted another archive: %d", wrongResponse.StatusCode)
	}
	for route, expected := range map[string]int{
		"/healthz": http.StatusServiceUnavailable, "/api/config": http.StatusServiceUnavailable,
		"/rtc": http.StatusNotFound, "/api/v2/challenge": http.StatusNotFound,
	} {
		response, err := read(route)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != expected {
			t.Fatalf("maintenance exposed %s with status %d", route, response.StatusCode)
		}
	}
	response, err := read("/api/v3/migration/challenge")
	if err != nil {
		t.Fatal(err)
	}
	var challenge migrationHistoryChallenge
	err = json.NewDecoder(response.Body).Decode(&challenge)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || challenge.ServerID != report.ServerID || !validHexID(challenge.Nonce, 64) {
		t.Fatalf("normal standalone startup lost the frozen server identity: %+v, %v", challenge, err)
	}
	proof := migrationHistoryProof{Nonce: challenge.Nonce, DeviceID: publicKeyID(owner.device.Public().(ed25519.PublicKey)), Limit: 1}
	frame, err := migrationHistoryProofFrame(report.ServerID, "checkpoint", proof)
	if err != nil {
		t.Fatal(err)
	}
	proof.Signature = b64.EncodeToString(ed25519.Sign(owner.device, frame))
	body, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	response, err = client.Post(base+"/api/v3/migration/checkpoint", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var checkpoint migrationHistoryResponse
	err = json.NewDecoder(response.Body).Decode(&checkpoint)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || checkpoint.ArchiveSHA256 != report.BackupArchiveSHA256 {
		t.Fatalf("owner checkpoint request: HTTP %d, decode error %v", response.StatusCode, err)
	}
	response, err = client.Post(base+"/api/v3/migration/control/report", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("migration control did not reject an unsigned request: HTTP %d", response.StatusCode)
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	<-done
	if processErr != nil {
		t.Fatalf("maintenance failed to stop from the managed stdin pipe: %v\n%s", processErr, log.String())
	}
	after, err := migrationFileSHA256(path)
	if err != nil || before != after {
		t.Fatalf("maintenance process wrote to the legacy database: %v", err)
	}
	if output, err := command("rebind").CombinedOutput(); err == nil || !strings.Contains(string(output), "cannot rebind") {
		t.Fatalf("maintenance allowed address rebind: %v\n%s", err, output)
	}
	statePath := filepath.Join(dir, "state.json")
	stateBytes, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, append(stateBytes, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if output, err := command("serve").CombinedOutput(); err == nil || !strings.Contains(string(output), "host identity does not match") {
		t.Fatalf("maintenance accepted a changed host identity: %v\n%s", err, output)
	}
	if err := os.Rename(statePath, filepath.Join(dir, "state-saved.json")); err != nil {
		t.Fatal(err)
	}
	if output, err := command("serve").CombinedOutput(); err == nil {
		t.Fatalf("maintenance initialized a missing host identity: %s", output)
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("maintenance recreated the identity file: %v", err)
	}
}
