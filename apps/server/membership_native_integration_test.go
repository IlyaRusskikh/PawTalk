package main

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMembershipNativeElectronTLSAndStorage(t *testing.T) {
	if testing.Short() {
		t.Skip("native Electron integration excluded by -short")
	}
	if runtime.GOOS != "windows" {
		t.Skip("actual Windows Electron/DPAPI integration runs on Windows")
	}
	executable, err := filepath.Abs("../../node_modules/electron/dist/electron.exe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(executable); err != nil {
		t.Skip("Electron is unavailable; run with installed Client dependencies")
	}
	var leaked atomic.Int32
	entries := []map[string]any{}
	for range 2 {
		s := testMembershipStore(t)
		cert, fingerprint, err := roomCertificateFor([]string{"127.0.0.1"}, time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		cfg := config{AuthBinding: "tls-sha256:" + fingerprint}
		handler := newMembershipHandler(s, cfg)
		server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("X-PawTalk-Should-Not-Arrive") != "" {
				leaked.Add(1)
			}
			if r.URL.Path == "/rtc/rtc/v1" {
				if r.Header.Get("Upgrade") == "websocket" {
					key := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
					connection, buffer, err := w.(http.Hijacker).Hijack()
					if err != nil {
						return
					}
					defer connection.Close()
					buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(key[:]) + "\r\n\r\n")
					buffer.Flush()
					connection.SetReadDeadline(time.Now().Add(3 * time.Second))
					var payload [256]byte
					connection.Read(payload[:])
					return
				}
				respond(w, 200, map[string]bool{"ok": true})
				return
			}
			handler.ServeHTTP(w, r)
		}))
		server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		server.StartTLS()
		t.Cleanup(server.Close)
		// Explicitly confirm fixture fingerprint is that of the listener, not a
		// certificate name or a hash of a public config document.
		digest := sha256.Sum256(server.TLS.Certificates[0].Certificate[0])
		if hex.EncodeToString(digest[:]) != fingerprint {
			t.Fatal("fixture TLS fingerprint mismatch")
		}
		setup, err := s.createBootstrap(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, map[string]any{"base": server.URL, "address": "pawtalk://" + server.Listener.Addr().String() + "/" + fingerprint, "fingerprint": fingerprint, "serverId": setup.ServerID, "inviteId": setup.InviteID, "token": setup.Token})
	}
	fixture, _ := json.Marshal(map[string]any{"servers": entries})
	testDir := t.TempDir()
	inputPath := filepath.Join(testDir, "fixture.json")
	logPath := filepath.Join(testDir, "native.log")
	if err = os.WriteFile(inputPath, fixture, 0600); err != nil {
		t.Fatal(err)
	}
	script, err := filepath.Abs("../client/windows/tests/membership-native.cjs")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, script)
	hideWindow(command)
	command.WaitDelay = 3 * time.Second
	for _, value := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(value), "ELECTRON_RUN_AS_NODE=") && !strings.HasPrefix(strings.ToUpper(value), "PAWTALK_NATIVE_TEST_DIR=") {
			command.Env = append(command.Env, value)
		}
	}
	command.Env = append(command.Env, "PAWTALK_NATIVE_TEST_DIR="+testDir, "PAWTALK_NATIVE_TEST_INPUT="+inputPath, "PAWTALK_NATIVE_TEST_LOG="+logPath)
	output, err := command.CombinedOutput()
	log, _ := os.ReadFile(logPath)
	output = append(output, log...)
	if err != nil {
		t.Fatalf("native Electron TLS/storage failed: %v\n%s", err, output)
	}
	if leaked.Load() != 0 {
		t.Fatal("wrong-pin request reached HTTP handler")
	}
	t.Log(string(output))
}
