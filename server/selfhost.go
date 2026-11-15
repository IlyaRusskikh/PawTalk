package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

type mediaURLKey struct{}

func roomCertificate(addresses []string) (tls.Certificate, string, error) {
	return roomCertificateFor(addresses, 30*24*time.Hour)
}

func roomCertificateFor(addresses []string, lifetime time.Duration) (tls.Certificate, string, error) {
	if len(addresses) > 64 {
		return tls.Certificate{}, "", fmt.Errorf("too many room addresses")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, "", err
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "PawTalk room"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(lifetime), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{"pawtalk.local"}}
	seen := make(map[string]bool)
	for _, address := range append([]string{"127.0.0.1", "::1"}, addresses...) {
		ip := net.ParseIP(address)
		if ip == nil {
			return tls.Certificate{}, "", fmt.Errorf("invalid room IP address")
		}
		if !seen[ip.String()] {
			template.IPAddresses = append(template.IPAddresses, ip)
			seen[ip.String()] = true
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return tls.Certificate{}, "", err
	}
	fingerprint := sha256.Sum256(der)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, hex.EncodeToString(fingerprint[:]), nil
}

// Runtime configuration arrives over stdin.
func selfhost() error {
	var c struct {
		Port            int
		MediaPort       int
		Key             string
		Secret          string
		Password        string
		MediaExecutable string
		MediaConfig     string
		Addresses       []string
		RequireE2EE     bool
		E2EEKeyID       string
		Name            string
	}
	if e := json.NewDecoder(os.Stdin).Decode(&c); e != nil {
		return e
	}
	if c.Port < 1024 || c.Port > 65535 || c.MediaPort < 1024 || c.MediaPort > 65535 || len(c.Secret) < 32 || len(c.Name) > 256 {
		return fmt.Errorf("invalid selfhost configuration")
	}
	media := exec.Command(c.MediaExecutable, "--config", c.MediaConfig)
	hideWindow(media)
	if e := media.Start(); e != nil {
		return e
	}
	mediaDone := make(chan struct{})
	go func() { _ = media.Wait(); close(mediaDone) }()
	defer func() { _ = media.Process.Kill(); <-mediaDone }()
	client := &http.Client{Timeout: 500 * time.Millisecond}
	ready := false
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		select {
		case <-mediaDone:
			return fmt.Errorf("media server exited; check ports")
		default:
		}
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", c.MediaPort))
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == 200 {
				ready = true
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		return fmt.Errorf("media server not ready; check ports")
	}
	certificate, fingerprint, e := roomCertificate(c.Addresses)
	if e != nil {
		return e
	}
	cfg := config{APIKey: c.Key, APISecret: c.Secret, RequireE2EE: true, AuthBinding: "tls-sha256:" + fingerprint, PresenceURL: fmt.Sprintf("http://127.0.0.1:%d", c.MediaPort)}
	listener, e := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", c.Port))
	if e != nil {
		return e
	}
	defer listener.Close()
	store, e := openMembershipStore(":memory:")
	if e != nil {
		return fmt.Errorf("open membership store: %w", e)
	}
	defer store.db.Close()
	if strings.TrimSpace(c.Name) != "" {
		if _, e = store.db.Exec("UPDATE server_state SET name=? WHERE id=1", strings.TrimSpace(c.Name)); e != nil {
			return e
		}
	}
	bootstrap, e := store.createBootstrap(context.Background())
	if e != nil {
		return e
	}
	apiHandler := newMembershipHandler(store, cfg)
	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", c.MediaPort))
	proxy := httputil.NewSingleHostReverseProxy(target)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, port, err := net.SplitHostPort(r.Host)
		if err != nil || net.ParseIP(host) == nil || port != fmt.Sprint(c.Port) {
			http.Error(w, "invalid host", 400)
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
		// Each request gets its own config: local host and remote guests use different addresses.
		apiHandler.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), mediaURLKey{}, "wss://"+r.Host+"/rtc")))
	})
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 8192, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}}
	go func() { <-mediaDone; _ = srv.Close() }()
	// Private parent pipe only: bootstrap never appears in server logs or public status.
	if e = json.NewEncoder(os.Stdout).Encode(map[string]any{"fingerprint": fingerprint, "bootstrap": bootstrap}); e != nil {
		return e
	}
	// Parent closes stdin on exit. This also releases listeners after an unexpected parent crash.
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		// The child media process is terminated by the deferred lifecycle cleanup.
		_ = srv.Close()
	}()
	return srv.Serve(tls.NewListener(listener, srv.TLSConfig))
}
