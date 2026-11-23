package main

import (
	"database/sql"
	"net/http"
	"sync"
	"time"

	"pawtalk/server/internal/access"
)

const protectedPresenceTTL = 60 * time.Second

type protectedActivity struct {
	away    bool
	expires time.Time
}

type protectedPresence struct {
	mu        sync.Mutex
	profiles  map[string]map[string]protectedActivity
	nextPrune time.Time
}

func (p *protectedPresence) update(actor access.Principal, away bool, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.profiles == nil {
		p.profiles = make(map[string]map[string]protectedActivity)
	}
	if !now.Before(p.nextPrune) {
		for profile, devices := range p.profiles {
			for device, activity := range devices {
				if !now.Before(activity.expires) {
					delete(devices, device)
				}
			}
			if len(devices) == 0 {
				delete(p.profiles, profile)
			}
		}
		p.nextPrune = now.Add(protectedPresenceTTL)
	}
	devices := p.profiles[actor.ProfileID]
	if devices == nil {
		devices = make(map[string]protectedActivity)
		p.profiles[actor.ProfileID] = devices
	}
	devices[actor.DeviceID] = protectedActivity{away: away, expires: now.Add(protectedPresenceTTL)}
}

func (p *protectedPresence) annotate(members []access.RosterMember, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := range members {
		status := "offline"
		for _, activity := range p.profiles[members[i].ID] {
			if !now.Before(activity.expires) {
				continue
			}
			status = "away"
			if !activity.away {
				status = "online"
				break
			}
		}
		members[i].Presence = status
	}
}

func (p *protectedRuntime) activityHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Away *bool `json:"away"`
	}
	if _, err := decodeMemberJSON(w, r, 64, &input); err != nil || input.Away == nil {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	tx, err := p.store.db.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	defer tx.Rollback()
	actor, err := p.resolveSession(memberBearer(r))(r.Context(), tx)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	p.presence.update(actor, *input.Away, p.store.now())
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}
