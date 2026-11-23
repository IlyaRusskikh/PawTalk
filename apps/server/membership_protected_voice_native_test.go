package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type voiceMediaStep struct {
	Publish    bool `json:"publish"`
	Subscribe  bool `json:"subscribe"`
	Disconnect bool `json:"disconnect,omitempty"`
}

func verifyProtectedVoiceMedia(t *testing.T, store *membershipStore, cfg config, grant memberVoice, speaker bool, steps []voiceMediaStep,
	change func(context.Context, config, int) error) {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Fatal("protected media smoke requires the Windows LiveKit and Electron binaries")
	}
	localPath := func(path string) string {
		t.Helper()
		absolute, err := filepath.Abs(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(absolute); err != nil {
			t.Fatal(err)
		}
		return absolute
	}
	freeTCP := func() int {
		t.Helper()
		conn, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		return conn.Addr().(*net.TCPAddr).Port
	}
	port, rtc := freeTCP(), freeTCP()
	packet, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	udp := packet.LocalAddr().(*net.UDPAddr).Port
	packet.Close()
	dir := t.TempDir()
	yamlPath := filepath.Join(dir, "media.yaml")
	settings := fmt.Sprintf("port: %d\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: %d\n  udp_port: %d\n  use_external_ip: false\n  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\nkeys:\n  %s: %s\nlogging:\n  level: error\n",
		port, rtc, udp, cfg.APIKey, cfg.APISecret)
	if err := os.WriteFile(yamlPath, []byte(settings), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	media := exec.CommandContext(ctx, localPath("../../resources/server/livekit-server.exe"), "--config", yamlPath)
	hideWindow(media)
	if err := media.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		media.Process.Kill()
		media.Wait()
	}()
	host := fmt.Sprintf("127.0.0.1:%d", port)
	for {
		connection, err := net.DialTimeout("tcp", host, 100*time.Millisecond)
		if err == nil {
			connection.Close()
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("local LiveKit did not start")
		case <-time.After(40 * time.Millisecond):
		}
	}
	sdk := localPath("../../node_modules/livekit-client/dist/livekit-client.umd.js")
	cfg.PresenceURL = "http://" + host
	target, err := url.Parse(cfg.PresenceURL)
	if err != nil {
		t.Fatal(err)
	}
	signaling := httptest.NewServer(membershipMediaHandler(store, cfg, target))
	defer signaling.Close()
	var stepLock sync.Mutex
	nextStep := 0
	browser := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/change" {
			stepLock.Lock()
			defer stepLock.Unlock()
			index, err := strconv.Atoi(r.URL.Query().Get("step"))
			if err != nil || index != nextStep || index >= len(steps) || change == nil {
				http.Error(w, "unexpected media fixture step", http.StatusBadRequest)
				return
			}
			if err := change(r.Context(), cfg, index); err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			nextStep++
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.URL.Path == "/sdk.js" {
			http.ServeFile(w, r, sdk)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><script src="/sdk.js"></script>`)
	}))
	defer browser.Close()
	electron := exec.CommandContext(ctx, localPath("../../node_modules/electron/dist/electron.exe"),
		localPath("../client/windows/scripts/protected-voice-integration.cjs"))
	hideWindow(electron)
	for _, value := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(value), "ELECTRON_RUN_AS_NODE=") {
			electron.Env = append(electron.Env, value)
		}
	}
	input, err := json.Marshal(map[string]any{
		"page": browser.URL, "media": "ws" + strings.TrimPrefix(signaling.URL, "http") + "/rtc",
		"token": grant.Token, "speaker": speaker, "steps": steps, "profile": t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	electron.Stdin = bytes.NewReader(input)
	output, err := electron.CombinedOutput()
	if err != nil || !bytes.Contains(output, []byte("PASS protected LiveKit voice permissions")) {
		t.Fatalf("protected media integration: %v\n%s", err, output)
	}
	t.Log(string(output))
	control, err := signedMediaClaims(cfg, map[string]any{"iss": cfg.APIKey, "sub": "protected-voice-fixture",
		"exp": time.Now().Add(time.Minute).Unix(), "video": map[string]bool{"roomList": true}})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(ctx, "POST", "http://"+host+"/twirp/livekit.RoomService/ListRooms", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+control)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var rooms struct {
		Rooms []struct {
			Name     string `json:"name"`
			Capacity uint32 `json:"max_participants"`
		} `json:"rooms"`
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("LiveKit room listing returned %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&rooms); err != nil {
		t.Fatal(err)
	}
	if len(rooms.Rooms) != 1 || rooms.Rooms[0].Name != grant.Room || rooms.Rooms[0].Capacity != 1 {
		t.Fatalf("LiveKit did not install the configured room capacity: %+v", rooms.Rooms)
	}
}
