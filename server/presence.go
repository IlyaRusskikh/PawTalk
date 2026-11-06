package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Only aggregate occupancy is public. Participant names and identities stay private.
func (a *app) presenceHandler() http.HandlerFunc {
	var mu sync.Mutex
	var expires time.Time
	var count int
	var available bool
	return func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if time.Now().After(expires) {
			expires = time.Now().Add(10 * time.Second)
			available = false
			base := a.cfg.PresenceURL
			if base == "" {
				base = strings.Replace(strings.Replace(a.cfg.LivekitURL, "wss://", "https://", 1), "ws://", "http://", 1)
			}
			claims, _ := json.Marshal(map[string]any{"iss": a.cfg.APIKey, "sub": "presence", "nbf": time.Now().Unix() - 5, "exp": time.Now().Unix() + 30, "video": map[string]any{"roomAdmin": true, "room": roomName}})
			unsigned := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + b64.EncodeToString(claims)
			mac := hmac.New(sha256.New, []byte(a.cfg.APISecret))
			mac.Write([]byte(unsigned))
			req, err := http.NewRequestWithContext(r.Context(), "POST", strings.TrimRight(base, "/")+"/twirp/livekit.RoomService/ListParticipants", bytes.NewBufferString(`{"room":"common"}`))
			if err == nil {
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Authorization", "Bearer "+unsigned+"."+b64.EncodeToString(mac.Sum(nil)))
				client := &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return fmt.Errorf("unexpected redirect") }}
				res, err := client.Do(req)
				if err == nil {
					defer res.Body.Close()
					var body struct {
						Participants []json.RawMessage `json:"participants"`
					}
					if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body) == nil {
						count = len(body.Participants)
						available = true
					}
					// LiveKit returns NotFound when the room has no participants yet.
					if res.StatusCode == http.StatusNotFound {
						var failure struct {
							Code string `json:"code"`
						}
						if json.NewDecoder(io.LimitReader(res.Body, 1024)).Decode(&failure) == nil && failure.Code == "not_found" {
							count = 0
							available = true
						}
					}
				}
			}
		}
		if !available {
			respond(w, 503, map[string]string{"error": "presence unavailable"})
			return
		}
		respond(w, 200, map[string]int{"participants": count})
	}
}
