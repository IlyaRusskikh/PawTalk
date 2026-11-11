package main

// A narrowly scoped GitHub relay with a persistent, single-installer cache.
import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const updateRepo = "/IlyaRusskikh/PawTalk"

var updateTag = regexp.MustCompile(`^(client-v|v)(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$`)

type updateCache struct {
	data    []byte
	expires time.Time
}
type updateRelay struct {
	client       *http.Client
	slots        chan struct{}
	mu           sync.Mutex
	cache        map[string]updateCache
	attempts     map[string]attempt
	installerDir string
	installerMu  sync.RWMutex
	installer    string
	fill         chan struct{}
}

func updateRedirect(req *http.Request, via []*http.Request) error {
	u := req.URL
	if len(via) >= 5 || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return fmt.Errorf("invalid update redirect")
	}
	if u.Host == "release-assets.githubusercontent.com" {
		return nil
	}
	// Only the GitHub owner/repository is case-insensitive, not the asset path.
	if u.Host == "github.com" && len(u.Path) > len(updateRepo) &&
		strings.EqualFold(u.Path[:len(updateRepo)], updateRepo) &&
		strings.HasPrefix(u.Path[len(updateRepo):], "/releases/download/") {
		return nil
	}
	return fmt.Errorf("update redirect host not allowed")
}

func newUpdateRelay(directory string) *updateRelay {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 15 * time.Second
	transport.MaxIdleConnsPerHost = 2
	if directory == "" {
		if base, err := os.UserCacheDir(); err == nil {
			directory = filepath.Join(base, "PawTalk", "update-relay")
		}
	}
	p := &updateRelay{client: &http.Client{Transport: transport, CheckRedirect: updateRedirect}, slots: make(chan struct{}, 2),
		cache: make(map[string]updateCache), attempts: make(map[string]attempt), installerDir: directory, fill: make(chan struct{}, 1)}
	// Completed files are atomically renamed into place; partials are never served.
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		if !entry.IsDir() && installerVersion(entry.Name()) != "" && (p.installer == "" || newerInstaller(entry.Name(), p.installer)) {
			p.installer = entry.Name()
		}
	}
	// This directory belongs to one running relay. Recover from interrupted fills
	// and from a crash between publishing the new file and removing the old one.
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && ((installerVersion(name) != "" && name != p.installer) || (strings.HasPrefix(name, ".installer-") && strings.HasSuffix(name, ".part"))) {
			_ = os.Remove(filepath.Join(directory, name))
		}
	}
	return p
}

// No caller-provided destination, credentials, cookies, forwarding headers or query URLs.
func updateTarget(r *http.Request) (string, int64, bool) {
	if r.URL.Path == "/api/updates/releases" {
		q := r.URL.Query()
		page, err := strconv.Atoi(q.Get("page"))
		if err != nil || page < 1 || page > 10 || q.Get("per_page") != "100" || len(q) != 2 {
			return "", 0, false
		}
		return "https://api.github.com/repos" + updateRepo + "/releases?per_page=100&page=" + strconv.Itoa(page), 2 * 1024 * 1024, true
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/updates/assets/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/api/updates/assets/") || len(parts) != 2 || !updateTag.MatchString(parts[0]) || r.URL.RawQuery != "" {
		return "", 0, false
	}
	name := parts[1]
	limit := int64(16384)
	if name != "update-manifest.json" {
		if name != "PawTalk.Setup."+strings.TrimPrefix(strings.TrimPrefix(parts[0], "client-"), "v")+".exe" {
			return "", 0, false
		}
		limit = 1024 * 1024 * 1024
	}
	return "https://github.com" + updateRepo + "/releases/download/" + url.PathEscape(parts[0]) + "/" + url.PathEscape(name), limit, true
}

func (p *updateRelay) allow(ip string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for key, entry := range p.attempts {
		if now.Sub(entry.start) >= time.Minute {
			delete(p.attempts, key)
		}
	}
	v, exists := p.attempts[ip]
	if !exists {
		if len(p.attempts) >= 4096 {
			return false
		}
		v.start = now
	}
	if v.count >= 20 {
		return false
	}
	v.count++
	p.attempts[ip] = v
	return true
}

func (p *updateRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if os.Getenv("PAWTALK_UPDATE_PROXY") == "false" {
		fail(w, 503, "Update relay disabled")
		return
	}
	target, limit, ok := updateTarget(r)
	if !ok {
		fail(w, 400, "Invalid update resource")
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if parsed := net.ParseIP(ip); parsed != nil && parsed.IsLoopback() {
		if forwarded := r.Header.Get("X-Real-IP"); net.ParseIP(forwarded) != nil {
			ip = forwarded
		}
	}
	if !p.allow(ip) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "Update relay rate limit")
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
	metadata := limit < 1024*1024*1024
	if metadata {
		p.mu.Lock()
		cached := p.cache[target]
		p.mu.Unlock()
		if time.Now().Before(cached.expires) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(cached.data)
			return
		}
	}
	select {
	case p.slots <- struct{}{}:
		defer func() { <-p.slots }()
	default:
		fail(w, 503, "Update relay busy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Minute)
	defer cancel()
	var partial *os.File
	if !metadata {
		name := filepath.Base(r.URL.Path)
		if p.serveInstaller(w, r, name) {
			return
		}
		// One cache fill at a time. A second client reuses the completed result
		// instead of opening another GitHub download for the same installer.
		select {
		case p.fill <- struct{}{}:
			defer func() { <-p.fill }()
		case <-ctx.Done():
			return
		}
		if p.serveInstaller(w, r, name) {
			return
		}
		if p.installerDir == "" || os.MkdirAll(p.installerDir, 0700) != nil {
			fail(w, 503, "Update cache unavailable")
			return
		}
		partial, err = os.CreateTemp(p.installerDir, ".installer-*.part")
		if err != nil {
			fail(w, 503, "Update cache unavailable")
			return
		}
		defer func() { _ = partial.Close(); _ = os.Remove(partial.Name()) }()
		w.Header().Set("X-PawTalk-Update-Cache", "miss")
	}
	upstream, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
	upstream.Header.Set("User-Agent", "PawTalk-update-relay")
	upstream.Header.Set("Accept", "application/vnd.github+json")
	res, err := p.client.Do(upstream)
	if err != nil {
		fail(w, 502, "GitHub unavailable")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		fail(w, 502, "GitHub update resource unavailable")
		return
	}
	if res.ContentLength > limit {
		fail(w, 502, "Update response too large")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if metadata {
		data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
		if err != nil || int64(len(data)) > limit {
			fail(w, 502, "Invalid update metadata")
			return
		}
		p.mu.Lock()
		if len(p.cache) >= 32 {
			clear(p.cache)
		}
		p.cache[target] = updateCache{data: data, expires: time.Now().Add(time.Minute)}
		p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
		return
	}
	if err := streamInstaller(w, io.TeeReader(res.Body, partial), res.ContentLength, limit); err != nil {
		panic(http.ErrAbortHandler)
	}
	if err := partial.Sync(); err != nil {
		log.Printf("update cache sync: %v", err)
		return // The client received the bytes, but this cache fill is unusable.
	}
	if err := partial.Close(); err != nil {
		log.Printf("update cache close: %v", err)
		return
	}
	p.publishInstaller(partial.Name(), filepath.Base(r.URL.Path))
}

// Refresh write deadlines for every chunk, including cached transfers. There is
// no bandwidth throttle; network and disk throughput determine transfer speed.
func streamInstaller(w http.ResponseWriter, body io.Reader, length, limit int64) error {
	controller := http.NewResponseController(w)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if length >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	}
	buf := make([]byte, 32*1024)
	var total int64
	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > limit {
				return fmt.Errorf("installer too large")
			}
			_ = controller.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := w.Write(buf[:n]); err != nil {
				return err
			}
			if err := controller.Flush(); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			if total == 0 || (length >= 0 && total != length) {
				return io.ErrUnexpectedEOF
			}
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}
