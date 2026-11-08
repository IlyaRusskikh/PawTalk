package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
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
	var members []previewPerson
	return func(w http.ResponseWriter, r *http.Request) {
		private := r.URL.Path == "/api/preview"
		if private {
			if _, ok := a.authorizeChat(w, r); !ok {
				return
			}
		}
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
						Participants []previewPerson `json:"participants"`
					}
					if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body) == nil {
						count = len(body.Participants)
						members = body.Participants
						available = true
					}
					// LiveKit returns NotFound when the room has no participants yet.
					if res.StatusCode == http.StatusNotFound {
						var failure struct {
							Code string `json:"code"`
						}
						if json.NewDecoder(io.LimitReader(res.Body, 1024)).Decode(&failure) == nil && failure.Code == "not_found" {
							count = 0
							members = nil
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
		if private {
			a.respondPreview(w, r, count, members)
		} else {
			respond(w, 200, map[string]int{"participants": count})
		}
	}
}

type previewPerson struct {
	Name       string            `json:"name"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

func (a *app) respondPreview(w http.ResponseWriter, r *http.Request, count int, members []previewPerson) {
	after, err := strconv.ParseInt(r.URL.Query().Get("readAfter"), 10, 64)
	if err != nil || after < 0 {
		fail(w, 400, "Invalid read cursor")
		return
	}
	if r.URL.Query().Get("readFeed") != a.chat.feed {
		after = 0
	}
	tx, err := a.chat.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 503, "Preview unavailable")
		return
	}
	defer tx.Rollback()
	var unread int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM chat_messages WHERE feed=? AND id>?", a.chat.feed, after).Scan(&unread); err != nil {
		fail(w, 503, "Preview unavailable")
		return
	}
	people := []map[string]any{}
	for _, person := range members[:min(3, len(members))] {
		item := map[string]any{"name": person.Name}
		id := person.Attributes["pawtalk.profile"]
		if id != "" {
			var profile chatProfileRecord
			if err := tx.QueryRowContext(r.Context(), "SELECT profile_id,revision,nickname,nonce,ciphertext FROM chat_profiles WHERE feed=? AND profile_id=?", a.chat.feed, id).Scan(&profile.ID, &profile.Revision, &profile.Nickname, &profile.Nonce, &profile.Ciphertext); err == nil {
				item["name"] = profile.Nickname
				item["profile"] = profile
			}
		}
		people = append(people, item)
	}
	if tx.Commit() != nil {
		fail(w, 503, "Preview unavailable")
		return
	}
	respond(w, 200, map[string]any{"participants": count, "people": people, "feed": a.chat.feed, "unread": unread, "encrypted": a.cfg.RequireE2EE})
}
