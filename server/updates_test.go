package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type updateRoundTrip func(*http.Request) (*http.Response, error)

func (f updateRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestUpdateResourcesAndRedirectsAreRestricted(t *testing.T) {
	for _, resource := range []string{
		"/api/updates/releases?per_page=100&page=1", "/api/updates/releases?per_page=100&page=10",
		"/api/updates/assets/v0.6.0/update-manifest.json", "/api/updates/assets/v0.6.0/Voicecord.Setup.0.6.0.exe",
	} {
		if _, _, ok := updateTarget(httptest.NewRequest("GET", resource, nil)); !ok {
			t.Fatal(resource)
		}
	}
	for _, resource := range []string{
		"/api/updates/releases?per_page=100&page=11", "/api/updates/releases?per_page=100&page=1&url=https://evil.example",
		"/api/updates/assets/v0.6.0/other.exe", "/api/updates/assets/v0.6.0/Voicecord.Setup.0.5.0.exe",
		"/api/updates/assets/v0.6.0/update-manifest.json?url=https://evil.example", "/api/updates/assets/v0.6.0/../secret",
	} {
		if _, _, ok := updateTarget(httptest.NewRequest("GET", resource, nil)); ok {
			t.Fatal(resource)
		}
	}
	for _, address := range []string{"http://release-assets.githubusercontent.com/file", "https://evil.example/file", "https://github.com/other/repo/releases/download/v1/file", "https://user@github.com/IlyaRusskikh/voicecord/releases/download/v1/file", "https://127.0.0.1/file"} {
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

func TestUpdateRelayCachesOnlyMetadataAndDoesNotForwardCredentials(t *testing.T) {
	p := newUpdateRelay()
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
	t.Setenv("VOICECORD_UPDATE_PROXY", "false")
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
		if r.URL.Path != updateRepo+"/releases/download/v0.6.0/Voicecord.Setup.0.6.0.exe" {
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
	p := newUpdateRelay()
	p.bytesPerSecond = 0
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
	r, _ := http.NewRequestWithContext(ctx, "GET", relay.URL+"/api/updates/assets/v0.6.0/Voicecord.Setup.0.6.0.exe", nil)
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
}

func TestUpdateRelayBoundsBusyAndOversizedResponses(t *testing.T) {
	p := newUpdateRelay()
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
	p.ServeHTTP(w, httptest.NewRequest("GET", "/api/updates/assets/v0.6.0/Voicecord.Setup.0.6.0.exe", nil))
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
