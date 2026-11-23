package main

import (
	"net/http"
	"sync"
	"time"

	"pawtalk/server/internal/access"
)

type voiceNetworkSample struct {
	RTT      *float64 `json:"rtt"`
	Loss     *float64 `json:"loss"`
	Deafened bool     `json:"deafened,omitempty"`
	Muted    bool     `json:"muted,omitempty"`
}

type voicePeerNetwork struct {
	SessionID string `json:"sessionId"`
	voiceNetworkSample
}

type voiceNetworkEntry struct {
	channel  string
	sample   voiceNetworkSample
	expires  time.Time
	controls bool
	commands map[string]voiceChannelCommand
}

type voiceChannelCommand struct {
	ID      string `json:"id"`
	Action  string `json:"action"`
	expires time.Time
}

type voiceNetworkCache struct {
	mu      sync.Mutex
	samples map[string]voiceNetworkEntry
}

func (c *voiceNetworkCache) forget(session string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.samples, session)
}

func (c *voiceNetworkCache) audioStatus(channel, session string, now time.Time) (muted, deafened bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.samples[session]
	if !ok || entry.channel != channel || !entry.expires.After(now) {
		return false, false
	}
	return entry.sample.Muted, entry.sample.Deafened
}

func (c *voiceNetworkCache) exchange(channel, session string, peers []string, sample voiceNetworkSample, controls bool, now time.Time) ([]voicePeerNetwork, []voiceChannelCommand, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.samples == nil {
		c.samples = make(map[string]voiceNetworkEntry)
	}
	for id, entry := range c.samples {
		if !entry.expires.After(now) {
			delete(c.samples, id)
		}
	}
	entry := c.samples[session]
	if entry.channel != channel || !controls {
		entry.commands = nil
	}
	previous := entry.sample
	if entry.channel != channel {
		previous = voiceNetworkSample{}
	}
	audioChanged := previous.Muted != sample.Muted || previous.Deafened != sample.Deafened
	commands := []voiceChannelCommand{}
	for action, command := range entry.commands {
		if command.expires.After(now) {
			commands = append(commands, command)
		} else {
			delete(entry.commands, action)
		}
	}
	entry.channel, entry.sample, entry.controls, entry.expires = channel, sample, controls, now.Add(15*time.Second)
	c.samples[session] = entry
	result := make([]voicePeerNetwork, 0, len(peers))
	for _, peer := range peers {
		if entry, ok := c.samples[peer]; ok && entry.channel == channel {
			result = append(result, voicePeerNetwork{peer, entry.sample})
		}
	}
	return result, commands, audioChanged
}

func (c *voiceNetworkCache) command(channel, session, action, id string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.samples[session]
	if !ok || entry.channel != channel || !entry.controls || !entry.expires.After(now) {
		return false
	}
	if entry.commands == nil {
		entry.commands = make(map[string]voiceChannelCommand)
	}
	entry.commands[action] = voiceChannelCommand{id, action, now.Add(15 * time.Second)}
	c.samples[session] = entry
	return true
}

func (a *membershipAPI) protectedVoiceChannelControl(w http.ResponseWriter, r *http.Request) {
	source, session := r.PathValue("source"), r.PathValue("session")
	var input struct{ Action string }
	if _, err := decodeMemberJSON(w, r, 80, &input); err != nil {
		memberFail(w, err)
		return
	}
	if !validHexID(source, 32) || !validHexID(session, 32) ||
		(input.Action != access.ChangeVoiceMute && input.Action != access.ChangeVoiceDeafen) {
		protectedVoiceFail(w, access.InvalidAction)
		return
	}
	ctx := r.Context()
	tx, err := a.store.db.BeginTx(ctx, nil)
	if err != nil {
		memberFail(w, err)
		return
	}
	defer tx.Rollback()
	_, actor, err := a.store.runtimeIdentityForToken(ctx, tx, memberBearer(r))
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	now := a.store.now()
	choices, err := access.ReadVoiceRestrictionChoices(ctx, tx, actor, source, session, now.UnixMilli())
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	for _, choice := range choices.Actions {
		if choice.Action == input.Action && !choice.Lift && !choice.ServerWide {
			id, err := randomHex(16)
			if err != nil {
				memberFail(w, err)
				return
			}
			if !a.store.voiceNetwork.command(source, session, input.Action, id, now) {
				memberFail(w, memberError(http.StatusConflict, "VOICE_CHANNEL_CONTROL_UNAVAILABLE"))
				return
			}
			if a.voiceChanged != nil {
				a.voiceChanged(source)
			}
			respond(w, http.StatusAccepted, map[string]bool{"queued": true})
			return
		}
	}
	protectedVoiceFail(w, access.ChannelRestricted)
}

func (a *membershipAPI) protectedVoiceTelemetry(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("source")
	var sample voiceNetworkSample
	if _, err := decodeMemberJSON(w, r, 128, &sample); err != nil {
		memberFail(w, err)
		return
	}
	if !validHexID(channel, 32) || sample.RTT != nil && (*sample.RTT < 0 || *sample.RTT > 60000) ||
		sample.Loss != nil && (*sample.Loss < 0 || *sample.Loss > 100) {
		protectedVoiceFail(w, access.InvalidAction)
		return
	}
	ctx := r.Context()
	tx, err := a.store.db.BeginTx(ctx, nil)
	if err != nil {
		memberFail(w, err)
		return
	}
	defer tx.Rollback()
	member, actor, err := a.store.runtimeIdentityForToken(ctx, tx, memberBearer(r))
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	now := a.store.now()
	peers, err := access.VoiceTelemetryPeers(ctx, tx, actor, member.SessionID, channel, now.UnixMilli())
	if err != nil {
		protectedVoiceFail(w, err)
		return
	}
	controls := r.URL.Query().Get("channelControls") == "1"
	samples, commands, audioChanged := a.store.voiceNetwork.exchange(channel, member.SessionID, peers, sample, controls, now)
	if err := tx.Rollback(); err != nil {
		memberFail(w, err)
		return
	}
	if audioChanged && a.voiceChanged != nil {
		a.voiceChanged(channel)
	}
	if controls {
		respond(w, http.StatusOK, struct {
			Peers    []voicePeerNetwork    `json:"peers"`
			Commands []voiceChannelCommand `json:"commands"`
		}{samples, commands})
		return
	}
	respond(w, http.StatusOK, samples)
}
