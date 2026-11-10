package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type updateRoundTrip func(*http.Request) (*http.Response, error)

func (f updateRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestUpdateResourcesAndRedirectsAreRestricted(t *testing.T) {
	for _, repository := range []string{"IlyaRusskikh/PawTalk", "IlyaRusskikh/pawtalk", "ilyarusskikh/PAWTALK"} {
		r, _ := http.NewRequest("GET", "https://github.com/"+repository+"/releases/download/v0.7.1/PawTalk.Setup.0.7.1.exe", nil)
		if err := updateRedirect(r, nil); err != nil {
			t.Fatal(repository, err)
		}
	}
	for _, resource := range []string{
		"/api/updates/releases?per_page=100&page=1", "/api/updates/releases?per_page=100&page=10",
		"/api/updates/assets/v0.6.0/update-manifest.json", "/api/updates/assets/v0.6.0/PawTalk.Setup.0.6.0.exe",
	} {
		if _, _, ok := updateTarget(httptest.NewRequest("GET", resource, nil)); !ok {
			t.Fatal(resource)
		}
	}
	for _, resource := range []string{
		"/api/updates/releases?per_page=100&page=11", "/api/updates/releases?per_page=100&page=1&url=https://evil.example",
		"/api/updates/assets/v0.6.0/other.exe", "/api/updates/assets/v0.6.0/PawTalk.Setup.0.5.0.exe",
		"/api/updates/assets/v0.6.0/update-manifest.json?url=https://evil.example", "/api/updates/assets/v0.6.0/../secret",
	} {
		if _, _, ok := updateTarget(httptest.NewRequest("GET", resource, nil)); ok {
			t.Fatal(resource)
		}
	}
	for _, address := range []string{"http://release-assets.githubusercontent.com/file", "https://evil.example/file", "https://github.com/other/repo/releases/download/v1/file", "https://github.com/IlyaRusskikh/PawTalk-evil/releases/download/v1/file", "https://github.com/IlyaRusskikh/PawTalk/RELEASES/download/v1/file", "https://user@github.com/IlyaRusskikh/pawtalk/releases/download/v1/file", "https://127.0.0.1/file"} {
		r, _ := http.NewRequest("GET", address, nil)
		if updateRedirect(r, nil) == nil {
			t.Fatal(address)
		}
	}
	r, _ := http.NewRequest("GET", "https://release-assets.githubusercontent.com/file?signature=value", nil)
	if err := updateRedirect(r, nil); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateRelayCachesMetadataAndDoesNotForwardCredentials(t *testing.T) {
	p := newUpdateRelay(t.TempDir())
	var calls atomic.Int32
	p.client.Transport = updateRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Forwarded-For") != "" {
			t.Error("forwarded client credentials")
		}
		if r.URL.Host != "api.github.com" || r.URL.Path != "/repos"+updateRepo+"/releases" {
			t.Error(r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("[]")), Header: make(http.Header), ContentLength: 2}, nil
	})
	for range 2 {
		r := httptest.NewRequest("GET", "/api/updates/releases?per_page=100&page=1", nil)
		r.Header.Set("Authorization", "Bearer private")
		r.Header.Set("Cookie", "private=value")
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		if w.Code != 200 || w.Body.String() != "[]" {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatal("metadata was not cached")
	}
	t.Setenv("PAWTALK_UPDATE_PROXY", "false")
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/api/updates/releases?per_page=100&page=1", nil))
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
}

func TestUpdateRelayStreamsBeforeUpstreamFinishesAndCancelsOnDisconnect(t *testing.T) {
	finish := make(chan struct{})
	cancelled := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != updateRepo+"/releases/download/v0.6.0/PawTalk.Setup.0.6.0.exe" {
			t.Error(r.URL.Path)
		}
		_, _ = w.Write([]byte("first"))
		w.(http.Flusher).Flush()
		select {
		case <-finish:
			_, _ = w.Write([]byte("last"))
		case <-r.Context().Done():
			close(cancelled)
		}
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	p := newUpdateRelay(t.TempDir())
	p.client.Transport = updateRoundTrip(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme = target.Scheme
		copy.URL.Host = target.Host
		return http.DefaultTransport.RoundTrip(copy)
	})
	relay := httptest.NewUnstartedServer(p)
	// The relay extends the API's short write deadline for installer streaming.
	relay.Config.WriteTimeout = time.Millisecond
	relay.Start()
	defer relay.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "GET", relay.URL+"/api/updates/assets/v0.6.0/PawTalk.Setup.0.6.0.exe", nil)
	res, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	first := make([]byte, 5)
	if _, err := io.ReadFull(res.Body, first); err != nil || !bytes.Equal(first, []byte("first")) {
		t.Fatal(string(first), err)
	}
	// First bytes reached the client while upstream is still waiting.
	if len(p.cache) != 0 {
		t.Fatal("installer was cached")
	}
	_ = res.Body.Close()
	cancel()
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		close(finish)
		t.Fatal("upstream not cancelled")
	}
	// Wait for the cancelled handler to remove its incomplete disk entry.
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		entries, _ := os.ReadDir(p.installerDir)
		if len(entries) == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("cancelled installer left a partial cache file")
}

func installerRequest(version string) *http.Request {
	return httptest.NewRequest("GET", "/api/updates/assets/v"+version+"/PawTalk.Setup."+version+".exe", nil)
}

func serveUpdateForTest(p *updateRelay, w http.ResponseWriter, r *http.Request) (aborted bool) {
	defer func() {
		if value := recover(); value != nil {
			if value != http.ErrAbortHandler {
				panic(value)
			}
			aborted = true
		}
	}()
	p.ServeHTTP(w, r)
	return
}

func TestInstallerCachePersistsReplacesOldAndSurvivesFailedUpgrade(t *testing.T) {
	directory := t.TempDir()
	p := newUpdateRelay(directory)
	var calls int
	broken := false
	p.client.Transport = updateRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("forwarded credentials")
		}
		body := []byte("installer " + r.URL.Path)
		length := int64(len(body))
		if broken {
			length++
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: length, Header: make(http.Header)}, nil
	})
	request := func(version string, abort bool) []byte {
		t.Helper()
		w := httptest.NewRecorder()
		r := installerRequest(version)
		r.Header.Set("Authorization", "private")
		r.Header.Set("Cookie", "private=value")
		if serveUpdateForTest(p, w, r) != abort {
			t.Fatal("unexpected stream completion", version)
		}
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		return w.Body.Bytes()
	}
	first := request("0.7.1", false)
	if !bytes.Equal(request("0.7.1", false), first) || calls != 1 {
		t.Fatal("installer was fetched twice")
	}
	// A restarted relay serves the disk entry even when GitHub is unavailable.
	restarted := newUpdateRelay(directory)
	restarted.client.Transport = updateRoundTrip(func(*http.Request) (*http.Response, error) {
		t.Error("cache hit contacted GitHub")
		return nil, io.ErrClosedPipe
	})
	w := httptest.NewRecorder()
	restarted.ServeHTTP(w, installerRequest("0.7.1"))
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), first) {
		t.Fatal("persistent cache miss")
	}
	broken = true
	request("0.8.0", true)
	if !bytes.Equal(request("0.7.1", false), first) || calls != 2 {
		t.Fatal("failed upgrade removed old cache")
	}
	broken = false
	request("0.8.0", false)
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 || entries[0].Name() != "PawTalk.Setup.0.8.0.exe" {
		t.Fatal("old or partial installers retained", entries, err)
	}
	// Older client requests are still served, but cannot evict the newer cache.
	request("0.7.1", false)
	entries, _ = os.ReadDir(directory)
	if len(entries) != 1 || entries[0].Name() != "PawTalk.Setup.0.8.0.exe" {
		t.Fatal("cache downgraded")
	}
}

func TestConcurrentInstallerRequestsShareOneUpstreamDownload(t *testing.T) {
	directory := t.TempDir()
	p := newUpdateRelay(directory)
	started, finish := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	body := bytes.Repeat([]byte("synthetic installer"), 10000)
	p.client.Transport = updateRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		reader, writer := io.Pipe()
		go func() {
			close(started)
			<-finish
			_, err := writer.Write(body)
			_ = writer.CloseWithError(err)
		}()
		return &http.Response{StatusCode: 200, Body: reader, ContentLength: int64(len(body)), Header: make(http.Header)}, nil
	})
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			p.ServeHTTP(w, installerRequest("0.7.1"))
			if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), body) {
				t.Error("incomplete concurrent response")
			}
		}()
		if i == 0 {
			<-started
		}
	}
	close(finish)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal("duplicate upstream downloads", calls.Load())
	}
	if data, err := os.ReadFile(filepath.Join(directory, "PawTalk.Setup.0.7.1.exe")); err != nil || !bytes.Equal(data, body) {
		t.Fatal("bad cached installer", err)
	}
}

func TestInstallerCacheVersionOrdering(t *testing.T) {
	for _, versions := range [][2]string{{"0.8.0", "0.7.99"}, {"0.8.0", "0.8.0-rc.1"}, {"0.8.0-rc.10", "0.8.0-rc.2"}, {"0.8.0-beta", "0.8.0-1"}, {"1.0.0", "0.9999999999999999999999999.0"}} {
		a, b := "PawTalk.Setup."+versions[0]+".exe", "PawTalk.Setup."+versions[1]+".exe"
		if !newerInstaller(a, b) || newerInstaller(b, a) || newerInstaller(a, a) {
			t.Fatal(versions)
		}
	}
}

func TestInstallerCacheRecoveryRemovesOldAndPartialFiles(t *testing.T) {
	directory := t.TempDir()
	for _, name := range []string{"PawTalk.Setup.0.7.0.exe", "PawTalk.Setup.0.7.1.exe", ".installer-crashed.part", "unrelated.txt"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte("synthetic"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	p := newUpdateRelay(directory)
	if p.installer != "PawTalk.Setup.0.7.1.exe" {
		t.Fatal(p.installer)
	}
	entries, _ := os.ReadDir(directory)
	if len(entries) != 2 {
		t.Fatal("crash recovery retained old/partial files", entries)
	}
	if _, err := os.Stat(filepath.Join(directory, "unrelated.txt")); err != nil {
		t.Fatal("removed unrelated file")
	}
}

func TestInstallerRelayHTTPStreamsAndReusesDiskCacheWithoutBandwidthCap(t *testing.T) {
	p := newUpdateRelay(t.TempDir())
	body := bytes.Repeat([]byte("installer"), 512*1024) // 4.5 MiB: the old cap needs >4 seconds.
	var calls atomic.Int32
	p.client.Transport = updateRoundTrip(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Header: make(http.Header)}, nil
	})
	relay := httptest.NewUnstartedServer(p)
	relay.Config.WriteTimeout = time.Second // Includes the TLS handshake, before our handler runs.
	relay.StartTLS()
	defer relay.Close()
	client := relay.Client()
	// Synthetic upstream, actual HTTPS downstream. Both the first streaming
	// response and the disk-cache response must finish before the old cap allows.
	for attempt := range 2 {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		r, _ := http.NewRequestWithContext(ctx, "GET", relay.URL+installerRequest("0.7.1").URL.String(), nil)
		res, err := client.Do(r)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		want := "miss"
		if attempt > 0 {
			want = "hit"
		}
		if res.Header.Get("X-PawTalk-Update-Cache") != want {
			t.Error("unexpected cache response", res.Header)
		}
		data, err := io.ReadAll(res.Body)
		_ = res.Body.Close()
		cancel()
		if err != nil || res.StatusCode != 200 || !bytes.Equal(data, body) {
			t.Fatal("HTTPS transfer failed", err, res.StatusCode)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("cache hit made an upstream request", calls.Load())
	}
}

func TestUpdateRelayBoundsBusyAndOversizedResponses(t *testing.T) {
	p := newUpdateRelay(t.TempDir())
	p.client.Transport = updateRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("oversized")), Header: make(http.Header), ContentLength: 20000}, nil
	})
	w := httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/api/updates/assets/v0.6.0/update-manifest.json", nil))
	if w.Code != 502 {
		t.Fatal(w.Code)
	}
	p.slots <- struct{}{}
	p.slots <- struct{}{}
	w = httptest.NewRecorder()
	p.ServeHTTP(w, httptest.NewRequest("GET", "/api/updates/assets/v0.6.0/PawTalk.Setup.0.6.0.exe", nil))
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
	for range 25 {
		w = httptest.NewRecorder()
		p.ServeHTTP(w, httptest.NewRequest("GET", "/api/updates/releases?per_page=100&page=1", nil))
	}
	if w.Code != 429 {
		t.Fatal(w.Code)
	}
}
