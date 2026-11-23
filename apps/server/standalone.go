package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var standalonePort = 18443
var mediaAddress = "http://127.0.0.1:18446"

// One atomic file keeps the certificate and media credentials consistent.
type serverState struct {
	IP, APIKey, APISecret, Certificate, PrivateKey string
}

func stateDir() string {
	if dir := os.Getenv("PAWTALK_DATA_DIR"); dir != "" {
		return dir
	}
	return "/data"
}

func saveState(dir string, state serverState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".state-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, "state.json"))
}

func readState(dir string) (serverState, error) {
	return readPinnedState(dir, "")
}

func readPinnedState(dir, expectedSHA256 string) (serverState, error) {
	var state serverState
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return state, err
	}
	if len(data) > 65536 {
		return state, errors.New("server state is too large")
	}
	if expectedSHA256 != "" {
		digest := sha256.Sum256(data)
		if hex.EncodeToString(digest[:]) != expectedSHA256 {
			return state, errors.New("migration host identity does not match the reserved backup")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&state)
	if err != nil {
		return state, fmt.Errorf("invalid state.json: %w", err)
	}
	if net.ParseIP(state.IP) == nil || state.APIKey == "" || len(state.APISecret) < 32 {
		return state, errors.New("invalid server state")
	}
	_, _, err = stateCertificate(state)
	return state, err
}

func createState(ip string) (serverState, error) {
	var state serverState
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.IsUnspecified() || parsed.IsMulticast() {
		return state, errors.New("PAWTALK_PUBLIC_IP must be the server's reachable IPv4 or IPv6 address")
	}
	state.IP = parsed.String()
	random := make([]byte, 48)
	if _, err := rand.Read(random); err != nil {
		return state, err
	}
	state.APIKey = "pt_" + hex.EncodeToString(random[:16])
	state.APISecret = hex.EncodeToString(random[16:])
	cert, _, err := roomCertificateFor([]string{state.IP}, 10*365*24*time.Hour)
	if err != nil {
		return state, err
	}
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		return state, err
	}
	state.Certificate = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}))
	state.PrivateKey = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))
	return state, nil
}

func stateCertificate(state serverState) (tls.Certificate, string, error) {
	cert, err := tls.X509KeyPair([]byte(state.Certificate), []byte(state.PrivateKey))
	if err != nil {
		return cert, "", err
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return cert, "", err
	}
	if err = leaf.VerifyHostname(state.IP); err != nil {
		return cert, "", err
	}
	if !time.Now().Before(leaf.NotAfter) {
		return cert, "", errors.New("server certificate expired; create a new data volume and distribute the new invitation")
	}
	fingerprint := sha256.Sum256(cert.Certificate[0])
	return cert, hex.EncodeToString(fingerprint[:]), nil
}

func invitation(state serverState) string {
	_, fingerprint, _ := stateCertificate(state)
	return "pawtalk://" + net.JoinHostPort(state.IP, fmt.Sprint(standalonePort)) + "/" + fingerprint
}

func mediaConfig(state serverState) string {
	return fmt.Sprintf("port: %d\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: %d\n  udp_port: %d\n  use_external_ip: false\n  node_ip: %s\nkeys:\n  %s: %s\nroom:\n  auto_create: true\n  empty_timeout: 300\n  max_participants: 30\nlogging:\n  level: info\n", standalonePort+3, standalonePort+1, standalonePort+2, state.IP, state.APIKey, state.APISecret)
}

func mediaReady() bool {
	client := &http.Client{Timeout: time.Second}
	res, err := client.Get(mediaAddress + "/")
	if err != nil {
		return false
	}
	defer res.Body.Close()
	return res.StatusCode == http.StatusOK
}

func standaloneMembershipHandler(state serverState, store *membershipStore) (http.Handler, error) {
	_, fingerprint, err := stateCertificate(state)
	if err != nil {
		return nil, err
	}
	cfg := standaloneMediaConfig(state)
	cfg.AuthBinding = "tls-sha256:" + fingerprint
	cfg.UpdateCacheDir = filepath.Join(stateDir(), "update-cache")
	api := newMembershipHandler(store, cfg)
	target, _ := url.Parse(mediaAddress)
	media := membershipMediaHandler(store, cfg, target)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Del("X-Real-IP")
		r.Header.Del("X-Forwarded-For")
		if r.URL.Path == "/healthz" && !mediaReady() {
			memberFail(w, memberError(503, "MEDIA_UNAVAILABLE"))
			return
		}
		if r.URL.Path == "/rtc" || strings.HasPrefix(r.URL.Path, "/rtc/") {
			media.ServeHTTP(w, r)
			return
		}
		api.ServeHTTP(w, r)
	}), nil
}

func standaloneMediaConfig(state serverState) config {
	return config{APIKey: state.APIKey, APISecret: state.APISecret, RequireE2EE: true, PresenceURL: mediaAddress,
		LivekitURL: "wss://" + net.JoinHostPort(state.IP, fmt.Sprint(standalonePort)) + "/rtc"}
}

func rebindRoom(state *serverState, ip string) error {
	if parsed := net.ParseIP(ip); parsed != nil && parsed.Equal(net.ParseIP(state.IP)) {
		return nil
	}
	// A new address needs a certificate covering it. Preserve the membership identity,
	// API key and history; revoke old sessions with the new signing secret.
	replacement, err := createState(ip)
	if err != nil {
		return err
	}
	state.IP, state.Certificate, state.PrivateKey, state.APISecret = replacement.IP, replacement.Certificate, replacement.PrivateKey, replacement.APISecret
	return nil
}

func standalone(args []string) error {
	if len(args) > 0 && strings.HasPrefix(args[0], "--") {
		return errors.New("API 2 encryption is mandatory; manual E2EE options are unsupported")
	}
	limit, err := chatStorageLimit()
	if err != nil {
		return err
	}
	if raw := os.Getenv("PAWTALK_PORT"); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil || port < 1024 || port > 65532 {
			return errors.New("PAWTALK_PORT must be 1024..65532")
		}
		standalonePort = port
		mediaAddress = fmt.Sprintf("http://127.0.0.1:%d", port+3)
	}
	dir := stateDir()
	databasePath := filepath.Join(dir, membershipDatabaseFile)
	if len(args) == 1 && args[0] == "migration-check" {
		report, err := inspectProtectedMigration(context.Background(), databasePath, time.Now())
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(report)
	}
	if len(args) == 2 && args[0] == "migration-prepare" {
		report, err := prepareProtectedMigration(context.Background(), dir, os.Stdin, args[1], time.Now())
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(report)
	}
	if len(args) == 2 && args[0] == "migration-verify" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		report, err := verifyStandaloneMigrationImport(ctx, dir, args[1])
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(report)
	}
	if len(args) == 2 && args[0] == "migration-approve-import" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		receipt, err := approveStandaloneMigrationImport(ctx, dir, args[1], os.Stdin)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(receipt)
	}
	if len(args) == 2 && args[0] == "migration-stage-policy" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		proof, err := stageStandaloneMigrationPolicy(ctx, dir, args[1], os.Stdin)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(proof)
	}
	if len(args) == 2 && args[0] == "migration-approve-cutover" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		receipt, err := approveStandaloneMigrationCutover(ctx, dir, args[1], os.Stdin)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(receipt)
	}
	if len(args) == 2 && args[0] == "migration-activate" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		activation, err := activateStandaloneProtectedRuntime(ctx, dir, args[1])
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(activation)
	}
	if len(args) > 0 && (args[0] == "healthcheck" || args[0] == "migration-healthcheck" || args[0] == "protected-healthcheck") {
		var expectedArchive string
		var expectedCutover string
		if args[0] == "migration-healthcheck" {
			if len(args) != 2 || !validHexID(args[1], 64) {
				return errors.New("usage: serve migration-healthcheck <archive-sha256>")
			}
			expectedArchive = args[1]
		}
		if args[0] == "protected-healthcheck" {
			if len(args) != 2 || !validHexID(args[1], 64) {
				return errors.New("usage: serve protected-healthcheck <cutover-sha256>")
			}
			expectedCutover = args[1]
		}
		path := "/healthz"
		expectedIdentity := ""
		migration, err := openStandaloneMigrationStore(databasePath)
		if err != nil {
			return err
		}
		if migration != nil {
			migration.db.Close()
			if !migration.active {
				path = migrationHealthPath
			}
			expectedIdentity = migration.identitySHA256
		}
		if expectedArchive != "" && (migration == nil || migration.active || migration.archiveSHA256 != expectedArchive) {
			return errors.New("local database does not match the expected migration checkpoint")
		}
		if expectedCutover != "" && (migration == nil || !migration.active) {
			return errors.New("local database has no activated protected runtime")
		}
		state, err := readPinnedState(dir, expectedIdentity)
		if err != nil {
			return err
		}
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM([]byte(state.Certificate))
		client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("https://127.0.0.1:%d%s", standalonePort, path), nil)
		if err != nil {
			return err
		}
		if expectedArchive != "" {
			request.Header.Set(migrationCheckpointHeader, expectedArchive)
		}
		res, err := client.Do(request)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return errors.New("server not ready")
		}
		if expectedCutover != "" {
			var health struct {
				Protocol int    `json:"apiProtocolVersion"`
				Cutover  string `json:"cutoverDigest"`
			}
			if json.NewDecoder(io.LimitReader(res.Body, 1024)).Decode(&health) != nil || health.Protocol != 3 || health.Cutover != expectedCutover {
				return errors.New("protected runtime does not match the expected cutover")
			}
		}
		return nil
	}
	if len(args) > 0 {
		state, err := readState(dir)
		if err != nil {
			return err
		}
		fresh, err := isProtectedStandaloneDatabase(databasePath)
		if err != nil {
			return err
		}
		switch args[0] {
		case "status":
			if fresh {
				db, err := openMembershipReadOnly(databasePath)
				if err != nil {
					return err
				}
				defer db.Close()
				serverID, ready, err := readProtectedStandaloneStatus(context.Background(), db)
				if err != nil {
					return err
				}
				return json.NewEncoder(os.Stdout).Encode(map[string]any{"apiProtocolVersion": 3, "dataSchema": protectedStandaloneSchemaVersion,
					"serverId": serverID, "initialized": ready != nil})
			}
			migration, err := openStandaloneMigrationStore(databasePath)
			if err != nil {
				return err
			}
			if migration != nil {
				defer migration.db.Close()
				authority, err := readFrozenMigrationAuthority(context.Background(), migration.db)
				if err != nil {
					return err
				}
				version := membershipMigrationSchemaVersion
				if migration.active {
					version = protectedDataSchemaVersion
				}
				return json.NewEncoder(os.Stdout).Encode(map[string]any{"apiProtocolVersion": 3, "dataSchema": version,
					"serverId": authority.serverID, "initialized": true, "maintenance": !migration.active})
			}
			status, err := inspectMembershipHost(databasePath)
			if err != nil {
				return err
			}
			return json.NewEncoder(os.Stdout).Encode(status)
		case "initial-admin":
			if fresh {
				address, err := issueProtectedStandaloneInvitation(context.Background(), databasePath, invitation(state)+"/v3")
				if err != nil {
					return err
				}
				fmt.Println(address)
				return nil
			}
			store, err := openMembershipStore(databasePath)
			if err != nil {
				return err
			}
			defer store.db.Close()
			initial, err := store.createBootstrap(context.Background())
			if err != nil {
				return err
			}
			params := url.Values{"v": {"2"}, "server": {initial.ServerID}, "invite": {initial.InviteID}, "token": {initial.Token}, "setup": {"1"}}
			fmt.Println(invitation(state) + "#" + params.Encode())
			return nil
		case "rebind":
			if fresh {
				return errors.New("cannot rebind an API 3 standalone server")
			}
			migration, err := openStandaloneMigrationStore(databasePath)
			if err != nil {
				return err
			}
			if migration != nil {
				migration.db.Close()
				return errors.New("cannot rebind the server during migration maintenance")
			}
			if err := rebindRoom(&state, os.Getenv("PAWTALK_PUBLIC_IP")); err != nil {
				return err
			}
			return saveState(dir, state)
		case "info":
			fmt.Println(invitation(state))
			return nil
		default:
			return errors.New("usage: serve [info|status|healthcheck|initial-admin|rebind|migration-check|migration-prepare <archive-sha256>|migration-verify <archive-sha256>|migration-approve-import <archive-sha256>|migration-stage-policy <archive-sha256>|migration-approve-cutover <archive-sha256>|migration-activate <archive-sha256>|migration-healthcheck <archive-sha256>]")
		}
	}
	migration, err := openStandaloneMigrationStore(databasePath)
	if err != nil {
		return err
	}
	expectedIdentity := ""
	if migration != nil {
		defer migration.db.Close()
		expectedIdentity = migration.identitySHA256
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	state, err := readPinnedState(dir, expectedIdentity)
	if errors.Is(err, os.ErrNotExist) && migration == nil {
		state, err = createState(os.Getenv("PAWTALK_PUBLIC_IP"))
		if err != nil {
			return err
		}
		if err = saveState(dir, state); err != nil {
			return err
		}
		log.Print("Create the first administrator invitation with serve initial-admin")
	} else if err != nil {
		return err
	}
	if ip := os.Getenv("PAWTALK_PUBLIC_IP"); ip != "" && !net.ParseIP(ip).Equal(net.ParseIP(state.IP)) {
		return errors.New("PAWTALK_PUBLIC_IP differs from saved state; restore the original IP or use a new data volume")
	}
	certificate, fingerprint, err := stateCertificate(state)
	if err != nil {
		return err
	}
	ctx, stop := standaloneShutdownContext()
	defer stop()
	fresh, err := isProtectedStandaloneDatabase(databasePath)
	if err != nil {
		return err
	}
	if !fresh && migration == nil && os.Getenv("PAWTALK_STANDALONE_AUTO_MIGRATION") == "true" {
		if _, err := os.Stat(databasePath); err == nil {
			status, err := inspectMembershipHost(databasePath)
			if err != nil {
				return err
			}
			if status["initialized"] == true {
				if err := prepareStandaloneMigration(ctx, dir); err != nil {
					return err
				}
				migration, err = openStandaloneMigrationStore(databasePath)
				if err != nil {
					return fmt.Errorf("open automatic migration checkpoint: %w", err)
				}
				if migration == nil {
					return errors.New("automatic migration did not create its checkpoint")
				}
				defer migration.db.Close()
			} else {
				if err := initializeProtectedStandalone(databasePath); err != nil {
					return err
				}
				fresh = true
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		} else {
			if err := initializeProtectedStandalone(databasePath); err != nil {
				return err
			}
			fresh = true
		}
	}
	if fresh {
		return serveFreshProtectedStandalone(ctx, databasePath, state, certificate, fingerprint, limit)
	}
	if migration != nil {
		if migration.active {
			return serveStandaloneProtectedRuntime(ctx, dir, databasePath, migration.archiveSHA256, state, certificate)
		}
		if _, err := os.Lstat(filepath.Join(dir, standaloneMigrationBackup)); err == nil {
			return serveAutomaticMigration(ctx, dir, databasePath, migration, state, certificate)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return serveStandaloneMigration(ctx, migration.membershipStore, databasePath, certificate, false)
	}
	store, err := openMembershipStore(databasePath)
	if err != nil {
		return fmt.Errorf("open membership store: %w", err)
	}
	defer store.db.Close()
	media, err := startStandaloneMedia(ctx, state)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	if err != nil {
		return err
	}
	defer media.shutdown()
	pollContext, stopPolls := context.WithCancel(ctx)
	defer stopPolls()
	store.maxBytes = limit
	go store.runPollClock(pollContext)
	handler, err := standaloneMembershipHandler(state, store)
	if err != nil {
		return err
	}
	return serveStandaloneTLS(ctx, standaloneHTTPServer(handler, certificate), "PawTalk ready.", media.done)
}

type standaloneMediaProcess struct {
	process    *os.Process
	done       chan error
	configPath string
}

func startStandaloneMedia(ctx context.Context, state serverState) (*standaloneMediaProcess, error) {
	// Runtime config stays in tmpfs, separate from persistent state.
	f, err := os.CreateTemp("", "pawtalk-livekit-*.yaml")
	if err != nil {
		return nil, err
	}
	path := f.Name()
	started := false
	defer func() {
		if !started {
			_ = os.Remove(path)
		}
	}()
	if _, err = f.WriteString(mediaConfig(state)); err != nil {
		f.Close()
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	executable := os.Getenv("PAWTALK_LIVEKIT_EXECUTABLE")
	if executable == "" {
		executable = "/livekit-server"
	}
	media := exec.Command(executable, "--config", path)
	media.Stdout, media.Stderr = os.Stdout, os.Stderr
	if err = media.Start(); err != nil {
		return nil, err
	}
	running := &standaloneMediaProcess{process: media.Process, done: make(chan error, 1), configPath: path}
	go func() { running.done <- media.Wait() }()
	poll := time.NewTicker(100 * time.Millisecond)
	defer poll.Stop()
	timeout := time.NewTimer(20 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case err := <-running.done:
			return nil, fmt.Errorf("media server exited: %v", err)
		case <-ctx.Done():
			running.shutdown()
			return nil, ctx.Err()
		case <-timeout.C:
			running.shutdown()
			return nil, errors.New("media server did not become ready")
		case <-poll.C:
			if mediaReady() {
				started = true
				return running, nil
			}
		}
	}
}

func (m *standaloneMediaProcess) shutdown() {
	defer os.Remove(m.configPath)
	if err := m.process.Signal(syscall.SIGTERM); err != nil {
		_ = m.process.Kill()
	}
	select {
	case <-m.done:
	case <-time.After(5 * time.Second):
		_ = m.process.Kill()
		<-m.done
	}
}

func standaloneShutdownContext() (context.Context, context.CancelFunc) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	// The native Windows service closes stdin before enforcing its job timeout.
	if os.Getenv("PAWTALK_MANAGED_STDIN") == "true" {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	}
	return ctx, stop
}

func standaloneHTTPServer(handler http.Handler, certificate tls.Certificate) *http.Server {
	return &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: time.Minute,
		MaxHeaderBytes: 8192, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}}
}

func shutdownStandaloneHTTP(server *http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	_ = server.Close() // Also close connections left after the shutdown deadline.
}
