package main

import (
	"context"
	"crypto/pbkdf2"
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

// One atomic file keeps the certificate, API keys and password hash consistent.
type serverState struct {
	IP, APIKey, APISecret, PasswordHash, Certificate, PrivateKey string
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
	err = json.Unmarshal(data, &state)
	if err != nil {
		return state, fmt.Errorf("invalid state.json: %w", err)
	}
	if net.ParseIP(state.IP) == nil || state.APIKey == "" || len(state.APISecret) < 32 {
		return state, errors.New("invalid server state")
	}
	if _, _, err = parseHash(state.PasswordHash); err != nil {
		return state, err
	}
	_, _, err = stateCertificate(state)
	return state, err
}

func passwordHash(password string) (string, error) {
	if len(password) < 8 || len(password) > 1024 {
		return "", errors.New("password must be 8..1024 bytes")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	digest, err := pbkdf2.Key(sha256.New, password, salt, 600000, 32)
	return "pbkdf2-sha256$600000$" + b64.EncodeToString(salt) + "$" + b64.EncodeToString(digest), err
}

func createState(ip string) (serverState, string, error) {
	var state serverState
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.IsUnspecified() || parsed.IsMulticast() {
		return state, "", errors.New("PAWTALK_PUBLIC_IP must be the server's reachable IPv4 or IPv6 address")
	}
	state.IP = parsed.String()
	random := make([]byte, 64)
	if _, err := rand.Read(random); err != nil {
		return state, "", err
	}
	password := b64.EncodeToString(random[:18])
	state.APIKey = "vc_" + hex.EncodeToString(random[18:30])
	state.APISecret = hex.EncodeToString(random[30:])
	var err error
	state.PasswordHash, err = passwordHash(password)
	if err != nil {
		return state, "", err
	}
	cert, _, err := roomCertificateFor([]string{state.IP}, 10*365*24*time.Hour)
	if err != nil {
		return state, "", err
	}
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		return state, "", err
	}
	state.Certificate = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}))
	state.PrivateKey = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))
	return state, password, nil
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

func standaloneHandler(state serverState, chat *chatStore) http.Handler {
	required, keyID, _ := encryptionPolicy() // Validated by standalone before accepting connections.
	a := &app{cfg: config{APIKey: state.APIKey, APISecret: state.APISecret, PasswordHash: state.PasswordHash, LivekitURL: "wss://" + net.JoinHostPort(state.IP, fmt.Sprint(standalonePort)) + "/rtc", RequireE2EE: required, E2EEKeyID: keyID}, chat: chat, attempts: make(map[string]attempt), hashSlots: make(chan struct{}, 4), now: time.Now}
	target, _ := url.Parse(mediaAddress)
	proxy := httputil.NewSingleHostReverseProxy(target)
	a.cfg.PresenceURL = mediaAddress
	api := a.handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// This listener is public; forwarding headers from callers are never trusted.
		r.Header.Del("X-Real-IP")
		r.Header.Del("X-Forwarded-For")
		if r.URL.Path == "/healthz" {
			if !mediaReady() {
				fail(w, 503, "media server unavailable")
				return
			}
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
	})
}

func standalone(args []string) error {
	for len(args) > 0 && strings.HasPrefix(args[0], "--") {
		switch {
		case args[0] == "--e2ee":
			_ = os.Setenv("PAWTALK_E2EE", "true")
		case strings.HasPrefix(args[0], "--e2ee-key-id="):
			_ = os.Setenv("PAWTALK_E2EE_KEY_ID", strings.TrimPrefix(args[0], "--e2ee-key-id="))
		default:
			return errors.New("unknown server option; supported: --e2ee, --e2ee-key-id=<sha256>")
		}
		args = args[1:]
	}
	required, keyID, err := encryptionPolicy()
	if err != nil {
		return err
	}
	if _, err := chatStorageLimit(); err != nil {
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
		case "info":
			fmt.Println(invitation(state))
			return nil
		case "reset-password":
			raw, err := io.ReadAll(io.LimitReader(os.Stdin, 1026))
			if err != nil {
				return err
			}
			state.PasswordHash, err = passwordHash(strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r"))
			if err != nil {
				return err
			}
			if err = saveState(dir, state); err != nil {
				return err
			}
			fmt.Println("Password updated. Restart the container to apply it.")
			return nil
		default:
			return errors.New("usage: serve [info|healthcheck|reset-password]")
		}
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	state, err := readState(dir)
	if errors.Is(err, os.ErrNotExist) {
		var password string
		state, password, err = createState(os.Getenv("PAWTALK_PUBLIC_IP"))
		if err != nil {
			return err
		}
		if err = saveState(dir, state); err != nil {
			return err
		}
		log.Printf("Initial room password (shown only on first start): %s", password)
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
	chat, closeChat, err := startRoomChat(filepath.Join(dir, "chat.sqlite"), required, keyID)
	if err != nil {
		return fmt.Errorf("open chat history: %w", err)
	}
	defer closeChat()
	srv := &http.Server{Handler: standaloneHandler(state, chat), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 8192, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(tls.NewListener(listener, srv.TLSConfig)) }()
	log.Printf("PawTalk ready. Invitation: %s", invitation(state))
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
