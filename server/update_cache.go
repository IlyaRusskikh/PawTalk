package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func installerVersion(name string) string {
	v := strings.TrimSuffix(strings.TrimPrefix(name, "PawTalk.Setup."), ".exe")
	if name != "PawTalk.Setup."+v+".exe" || !updateTag.MatchString("v"+v) {
		return ""
	}
	return v
}

// Compare SemVer identifiers as strings to avoid integer overflow on public
// request paths. Numeric prerelease identifiers sort below nonnumeric ones.
func compareUpdateIdentifier(a, b string, numeric bool) int {
	if numeric {
		a, b = strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
		if len(a) < len(b) {
			return -1
		}
		if len(a) > len(b) {
			return 1
		}
	}
	return strings.Compare(a, b)
}

func numericUpdateIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func newerInstaller(a, b string) bool {
	av, apre, _ := strings.Cut(installerVersion(a), "-")
	bv, bpre, _ := strings.Cut(installerVersion(b), "-")
	an, bn := strings.Split(av, "."), strings.Split(bv, ".")
	for i := range an {
		if c := compareUpdateIdentifier(an[i], bn[i], true); c != 0 {
			return c > 0
		}
	}
	if apre == "" || bpre == "" {
		return apre == "" && bpre != ""
	}
	ap, bp := strings.Split(apre, "."), strings.Split(bpre, ".")
	for i := 0; i < len(ap) && i < len(bp); i++ {
		na, nb := numericUpdateIdentifier(ap[i]), numericUpdateIdentifier(bp[i])
		if na != nb {
			return !na
		}
		if c := compareUpdateIdentifier(ap[i], bp[i], na); c != 0 {
			return c > 0
		}
	}
	return len(ap) > len(bp)
}

func (p *updateRelay) serveInstaller(w http.ResponseWriter, r *http.Request, name string) bool {
	// Hold a shared lock until close: Windows cannot remove an installer while
	// it is open. Publication waits for old cached transfers to finish.
	p.installerMu.RLock()
	defer p.installerMu.RUnlock()
	if p.installer != name {
		return false
	}
	f, err := os.Open(filepath.Join(p.installerDir, name))
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 1024*1024*1024 {
		return false
	}
	w.Header().Set("X-PawTalk-Update-Cache", "hit")
	if err := streamInstaller(w, f, info.Size(), info.Size()); err != nil {
		panic(http.ErrAbortHandler)
	}
	return true
}

func (p *updateRelay) publishInstaller(partial, name string) {
	p.installerMu.Lock()
	defer p.installerMu.Unlock()
	// Requests for an older release must not evict an already cached newer one.
	if p.installer != "" && newerInstaller(p.installer, name) {
		return
	}
	if p.installer == name {
		_ = os.Remove(filepath.Join(p.installerDir, name))
	}
	if err := os.Rename(partial, filepath.Join(p.installerDir, name)); err != nil {
		log.Printf("update cache publish: %v", err)
		return
	}
	p.installer = name
	entries, _ := os.ReadDir(p.installerDir)
	for _, entry := range entries {
		if !entry.IsDir() && entry.Name() != name && installerVersion(entry.Name()) != "" {
			if err := os.Remove(filepath.Join(p.installerDir, entry.Name())); err != nil {
				log.Printf("update cache remove old installer: %v", err)
			}
		}
	}
}
