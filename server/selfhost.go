package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/pbkdf2"
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
	}
	if e := json.NewDecoder(os.Stdin).Decode(&c); e != nil {
		return e
	}
	if c.Port < 1024 || c.Port > 65535 || c.MediaPort < 1024 || c.MediaPort > 65535 || len(c.Password) < 8 || len(c.Password) > 1024 || len(c.Secret) < 32 {
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
	salt := make([]byte, 16)
	if _, e = rand.Read(salt); e != nil {
		return e
	}
	digest, e := pbkdf2.Key(sha256.New, c.Password, salt, 600000, 32)
	if e != nil {
		return e
	}
	cfg := config{APIKey: c.Key, APISecret: c.Secret, PasswordHash: "pbkdf2-sha256$600000$" + b64.EncodeToString(salt) + "$" + b64.EncodeToString(digest), RequireE2EE: c.RequireE2EE, E2EEKeyID: c.E2EEKeyID}
	listener, e := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", c.Port))
	if e != nil {
		return e
	}
	defer listener.Close()
	chat, closeChat, e := startRoomChat(":memory:", cfg.RequireE2EE, cfg.E2EEKeyID)
	if e != nil {
		return fmt.Errorf("open chat history: %w", e)
	}
	defer closeChat()
	a := &app{cfg: cfg, chat: chat, attempts: make(map[string]attempt), hashSlots: make(chan struct{}, 4), now: time.Now}
	a.cfg.PresenceURL = fmt.Sprintf("http://127.0.0.1:%d", c.MediaPort)
	apiHandler := a.handler()
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
	if e = json.NewEncoder(os.Stdout).Encode(map[string]string{"fingerprint": fingerprint}); e != nil {
		return e
	}
	// Parent closes stdin on exit. This also releases listeners after an unexpected parent crash.
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		// Tell guests the room ended, so they do not spend minutes reconnecting.
		claims, _ := json.Marshal(map[string]any{"iss": c.Key, "sub": "host", "nbf": time.Now().Unix() - 5, "exp": time.Now().Unix() + 30, "video": map[string]bool{"roomCreate": true}})
		unsigned := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + b64.EncodeToString(claims)
		mac := hmac.New(sha256.New, []byte(c.Secret))
		_, _ = mac.Write([]byte(unsigned))
		req, _ := http.NewRequest("POST", target.String()+"/twirp/livekit.RoomService/DeleteRoom", bytes.NewBufferString(`{"room":"common"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+unsigned+"."+b64.EncodeToString(mac.Sum(nil)))
		if response, err := client.Do(req); err == nil {
			_ = response.Body.Close()
		}
		_ = srv.Close()
	}()
	return srv.Serve(tls.NewListener(listener, srv.TLSConfig))
}
