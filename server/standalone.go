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
	"net/http/httputil"
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
	var state serverState
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return state, err
	}
	if len(data) > 65536 {
		return state, errors.New("server state is too large")
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
	cfg := config{APIKey: state.APIKey, APISecret: state.APISecret, RequireE2EE: true,
		AuthBinding: "tls-sha256:" + fingerprint, PresenceURL: mediaAddress,
		LivekitURL: "wss://" + net.JoinHostPort(state.IP, fmt.Sprint(standalonePort)) + "/rtc", UpdateCacheDir: filepath.Join(stateDir(), "update-cache")}
	api := newMembershipHandler(store, cfg)
	target, _ := url.Parse(mediaAddress)
	proxy := httputil.NewSingleHostReverseProxy(target)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Del("X-Real-IP")
		r.Header.Del("X-Forwarded-For")
		if r.URL.Path == "/healthz" && !mediaReady() {
			memberFail(w, memberError(503, "MEDIA_UNAVAILABLE"))
			return
		}
		if r.URL.Path == "/rtc" || strings.HasPrefix(r.URL.Path, "/rtc/") {
			r.URL.Path = strings.TrimPrefix(r.URL.Path, "/rtc")
			if r.URL.Path == "" {
				r.URL.Path = "/"
			}
			proxy.ServeHTTP(w, r)
			return
		}
		api.ServeHTTP(w, r)
	}), nil
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
	if len(args) > 0 && args[0] == "healthcheck" {
		state, err := readState(dir)
		if err != nil {
			return err
		}
		pool := x509.NewCertPool()
		pool.AppendCertsFromPEM([]byte(state.Certificate))
		client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}
		res, err := client.Get(fmt.Sprintf("https://127.0.0.1:%d/healthz", standalonePort))
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return errors.New("server not ready")
		}
		return nil
	}
	if len(args) > 0 {
		state, err := readState(dir)
		if err != nil {
			return err
		}
		switch args[0] {
		case "status":
			status, err := inspectMembershipHost(filepath.Join(dir, "membership-v2.sqlite"))
			if err != nil {
				return err
			}
			return json.NewEncoder(os.Stdout).Encode(status)
		case "initial-admin":
			store, err := openMembershipStore(filepath.Join(dir, "membership-v2.sqlite"))
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
			if err := rebindRoom(&state, os.Getenv("PAWTALK_PUBLIC_IP")); err != nil {
				return err
			}
			return saveState(dir, state)
		case "info":
			fmt.Println(invitation(state))
			return nil
		default:
			return errors.New("usage: serve [info|status|healthcheck|initial-admin|rebind]")
		}
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	state, err := readState(dir)
	if errors.Is(err, os.ErrNotExist) {
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
	certificate, _, err := stateCertificate(state)
	if err != nil {
		return err
	}
	// Runtime config stays in tmpfs, separate from persistent state.
	f, err := os.CreateTemp("", "pawtalk-livekit-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(mediaConfig(state)); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	executable := os.Getenv("PAWTALK_LIVEKIT_EXECUTABLE")
	if executable == "" {
		executable = "/livekit-server"
	}
	media := exec.Command(executable, "--config", f.Name())
	media.Stdout, media.Stderr = os.Stdout, os.Stderr
	if err = media.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- media.Wait() }()
	defer func() {
		_ = media.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = media.Process.Kill()
			<-done
		}
	}()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The native Windows service closes stdin for a graceful shutdown before
	// its job object enforces a process-tree timeout. Containers keep signal handling.
	if os.Getenv("PAWTALK_MANAGED_STDIN") == "true" {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	}
	for deadline := time.Now().Add(20 * time.Second); ; {
		if mediaReady() {
			break
		}
		if time.Now().After(deadline) {
			return errors.New("media server did not become ready")
		}
		select {
		case err = <-done:
			done <- err
			return fmt.Errorf("media server exited: %v", err)
		case <-ctx.Done():
			return nil
		case <-time.After(100 * time.Millisecond):
		}
	}
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", standalonePort))
	if err != nil {
		return err
	}
	defer listener.Close()
	store, err := openMembershipStore(filepath.Join(dir, "membership-v2.sqlite"))
	if err != nil {
		return fmt.Errorf("open membership store: %w", err)
	}
	defer store.db.Close()
	store.maxBytes = limit
	handler, err := standaloneMembershipHandler(state, store)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 8192, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(tls.NewListener(listener, srv.TLSConfig)) }()
	log.Print("PawTalk ready.")
	select {
	case <-ctx.Done():
	case err = <-done:
		done <- err
		err = fmt.Errorf("media server exited: %v", err)
	case err = <-served:
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
	_ = srv.Close() // Also close connections left after the shutdown deadline.
	return err
}
