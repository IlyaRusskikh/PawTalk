package main

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var b64 = base64.RawURLEncoding

// Host transport/media settings. Admission and E2EE policy live in API 2.
type config struct {
	UpdateCacheDir, PresenceURL, APIKey, APISecret, LivekitURL, AuthBinding string
	RequireE2EE                                                             bool
}

type attempt struct {
	count int
	start time.Time
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// Update relay errors retain their independent protocol.
func fail(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}

func validNickname(name string) bool {
	length := utf8.RuneCountInString(name)
	return utf8.ValidString(name) && length >= 1 && length <= 32 && strings.IndexFunc(name, unicode.IsControl) < 0
}

func main() {
	if len(os.Args) > 1 {
		var err error
		switch os.Args[1] {
		case "serve":
			err = standalone(os.Args[2:])
		case "selfhost":
			err = selfhost()
		default:
			log.Fatal("usage: pawtalk-api serve [info|status|healthcheck|initial-admin|rebind], or selfhost over the private client pipe")
		}
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	log.Fatal("usage: pawtalk-api serve or selfhost; API 1 is unsupported")
}
