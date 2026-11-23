package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"pawtalk/server/internal/access"
)

type protectedEventFrame struct {
	Type      string                      `json:"type"`
	Sequence  uint64                      `json:"sequence"`
	ChannelID string                      `json:"channelId,omitempty"`
	Delivery  *access.LiveMessageDelivery `json:"delivery,omitempty"`
	ProfileID string                      `json:"profileId,omitempty"`
	Activity  string                      `json:"activity,omitempty"`
}

type protectedEventStream struct {
	sequence uint64
	view     [sha256.Size]byte
	voice    bool
	composer bool
}

var errProtectedFrameSize = errors.New("protected delivery exceeds frame limit")

func protectedEventCursor(r *http.Request) (uint64, bool) {
	query := r.URL.Query()
	if r.URL.RawQuery == "" {
		return 0, true
	}
	values := query["after"]
	if len(values) != 1 {
		return 0, false
	}
	base := "after=" + values[0]
	switch strings.TrimSuffix(r.URL.RawQuery, "&composer=1") {
	case base, base + "&delivery=1", base + "&voice=1", base + "&delivery=1&voice=1":
	default:
		return 0, false
	}
	after, err := strconv.ParseUint(values[0], 10, 53)
	return after, err == nil && after < uint64(migrationMaxSafePosition) && values[0] == strconv.FormatUint(after, 10)
}

func (p *protectedRuntime) eventsHTTP(w http.ResponseWriter, r *http.Request) {
	sequence, valid := protectedEventCursor(r)
	pushContent := r.URL.Query().Get("delivery") == "1"
	key, err := base64.StdEncoding.Strict().DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	if !valid || err != nil || len(key) != 16 || r.Header.Get("Sec-WebSocket-Version") != "13" ||
		!headerToken(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || r.Header.Get("Origin") != "" {
		memberFail(w, memberError(http.StatusBadRequest, "INVALID_WEBSOCKET"))
		return
	}
	resolve := p.resolveSession(memberBearer(r))
	actor, err := resolve(r.Context(), p.store.db)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	composer := r.URL.Query().Get("composer") == "1"
	wake, unsubscribe, ok := p.events.subscribeStream(actor.DeviceID, "", true, composer)
	if !ok {
		memberFail(w, memberError(http.StatusTooManyRequests, "RATE_LIMIT"))
		return
	}
	defer unsubscribe()
	conn, reader, err := upgradeMembershipWS(w, r.Header.Get("Sec-WebSocket-Key"))
	if err != nil {
		return
	}
	defer conn.Close()
	controls := make(chan wsControl, 4)
	done := make(chan struct{})
	go func() { defer close(done); readWSControls(conn, reader, controls) }()
	stream := protectedEventStream{sequence: sequence, voice: r.URL.Query().Get("voice") == "1", composer: composer}
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	deliver := func(trigger string, batch []memberEvent) bool {
		notices := make([]access.ScopedEvent, 0, len(batch))
		invalidated := make(map[string]bool)
		for _, event := range batch {
			if event.Type == "resync" {
				trigger = "resync"
			}
			if event.Type == "chat" && !event.protectedAppend {
				invalidated[event.ChannelID] = true
			}
		}
		var deliveries []access.ScopedEvent
		for _, event := range batch {
			if event.Type == "composer" {
				if stream.composer {
					notices = append(notices, access.ScopedEvent{ChannelID: event.ChannelID,
						SenderProfileID: event.composerProfileID, Payload: []byte(event.composerKind)})
				}
				continue
			}
			if event.Type == "voice" && !stream.voice {
				continue
			}
			if event.protectedProfileID != "" {
				notices = append(notices, access.ScopedEvent{ProfileID: event.protectedProfileID, Payload: []byte("state")})
				continue
			}
			if event.ChannelID != "" {
				scoped := access.ScopedEvent{ChannelID: event.ChannelID, OriginalPosition: uint64(event.Last),
					Content: event.Last > 0, Payload: []byte(event.Type)}
				if pushContent && trigger != "resync" && len(batch) <= 16 && event.protectedAppend && !invalidated[event.ChannelID] {
					deliveries = append(deliveries, scoped)
				} else {
					notices = append(notices, scoped)
				}
			}
		}
		err := store.DispatchVisibleEvents(r.Context(), resolve, notices, func(view access.Projection) error {
			return stream.deliver(conn, view, trigger)
		})
		if err == nil {
			var fallback []access.ScopedEvent
			for _, event := range deliveries {
				sent := false
				var writeErr error
				_ = store.DispatchLiveMessageDelivery(r.Context(), resolve, event.ChannelID, event.OriginalPosition,
					&p.textPolicyProofs, p.importedProfileNames != nil, verifyProtectedEpochSignature,
					func(delivery access.LiveMessageDelivery) error {
						writeErr = stream.writeFrame(conn, "message", event.ChannelID, &delivery)
						sent = writeErr == nil
						return writeErr
					})
				if writeErr != nil && !errors.Is(writeErr, errProtectedFrameSize) {
					err = writeErr
					break
				}
				if !sent {
					fallback = append(fallback, event)
				}
			}
			if err == nil && len(fallback) != 0 {
				err = store.DispatchVisibleEvents(r.Context(), resolve, fallback, func(view access.Projection) error {
					return stream.deliver(conn, view, "")
				})
			}
		}
		if err != nil {
			_ = writeWSWithin(conn, 8, []byte{3, 240}, 250*time.Millisecond)
		}
		return err == nil
	}
	if !deliver("resync", nil) {
		return
	}
	tick := time.NewTicker(15 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-done:
			return
		case control := <-controls:
			switch control.op {
			case 8:
				_ = writeWS(conn, 8, control.data)
				return
			case 9:
				if writeWS(conn, 10, control.data) != nil {
					return
				}
			}
		case <-wake:
			if !deliver("", p.events.drain(wake)) {
				return
			}
		case <-tick.C:
			if !deliver("heartbeat", nil) || writeWS(conn, 9, nil) != nil {
				return
			}
		}
	}
}

func (stream *protectedEventStream) deliver(conn net.Conn, view access.Projection, trigger string) error {
	notices := view.Events
	view.Events = nil
	// Revisions can advance because of changes entirely outside a viewer's
	// scope. Only changes in the viewer's own projection wake that account.
	if !view.CanInspectPolicy {
		view.PolicyRevision = 0
	}
	raw, err := json.Marshal(view)
	if err != nil {
		return err
	}
	fingerprint := sha256.Sum256(raw)
	stateChanged := stream.view != fingerprint
	stream.view = fingerprint
	if err := conn.SetWriteDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		return err
	}
	if trigger == "resync" {
		return stream.write(conn, trigger, "")
	}
	channels := make(map[string]bool, len(notices))
	voiceChannels := make(map[string]bool)
	for _, event := range notices {
		if event.SenderProfileID != "" {
			if err := stream.writeEvent(conn, protectedEventFrame{Type: "composer", ChannelID: event.ChannelID,
				ProfileID: event.SenderProfileID, Activity: string(event.Payload)}); err != nil {
				return err
			}
		} else if string(event.Payload) == "state" {
			stateChanged = true
		} else if string(event.Payload) == "voice" {
			if stream.voice && !voiceChannels[event.ChannelID] {
				voiceChannels[event.ChannelID] = true
				if err := stream.write(conn, "voice", event.ChannelID); err != nil {
					return err
				}
			}
		} else if !channels[event.ChannelID] {
			channels[event.ChannelID] = true
			if err := stream.write(conn, "chat", event.ChannelID); err != nil {
				return err
			}
		}
	}
	if stateChanged {
		if err := stream.write(conn, "state", ""); err != nil {
			return err
		}
	}
	if trigger != "" {
		return stream.write(conn, trigger, "")
	}
	return nil
}

func (stream *protectedEventStream) write(conn net.Conn, kind, channel string) error {
	return stream.writeFrame(conn, kind, channel, nil)
}

func (stream *protectedEventStream) writeFrame(conn net.Conn, kind, channel string, delivery *access.LiveMessageDelivery) error {
	return stream.writeEvent(conn, protectedEventFrame{Type: kind, ChannelID: channel, Delivery: delivery})
}

func (stream *protectedEventStream) writeEvent(conn net.Conn, frame protectedEventFrame) error {
	if stream.sequence >= uint64(migrationMaxSafePosition) {
		return errors.New("protected event sequence exhausted")
	}
	frame.Sequence = stream.sequence + 1
	payload, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if len(payload) > 60000 {
		return errProtectedFrameSize
	}
	if err := conn.SetWriteDeadline(time.Now().Add(250 * time.Millisecond)); err != nil {
		return err
	}
	stream.sequence++
	return writeWSFrame(conn, 1, payload)
}

func (p *protectedRuntime) publishProtectedChat(channel string, position uint64) {
	p.events.publish(memberEvent{Type: "chat", ChannelID: channel, Last: int64(position), Revision: int64(position), Delivery: true})
}

func (p *protectedRuntime) publishProtectedVoice(channel string) {
	p.events.publish(memberEvent{Type: "voice", ChannelID: channel})
}

func (p *protectedRuntime) publishProtectedMutation(r *http.Request) {
	channel := r.PathValue("channel")
	switch r.Pattern {
	case "PUT /api/v3/history/pins/{channel}/{position}", "DELETE /api/v3/history/message/{channel}/{position}",
		"DELETE /api/v3/history/poll/{channel}/{position}", "PUT /api/v3/history/poll/{channel}/{position}",
		"PUT /api/v3/history/poll/{channel}/{position}/close", "PUT /api/v3/history/checklist/{channel}/{position}",
		"PUT /api/v3/history/revision/{channel}/{position}":
		if pos, err := strconv.ParseUint(r.PathValue("position"), 10, 53); err == nil && pos > 0 {
			p.publishProtectedChat(channel, pos)
		}
	case "POST /api/v3/keys/rotate/{channel}/{purpose}/commit", "POST /api/v3/keys/rotate/{channel}/{purpose}/claim":
		p.events.publish(memberEvent{Type: "state", ChannelID: channel})
	case "PUT /api/v3/community/name", "PUT /api/v3/community/avatar", "PUT /api/v3/community/avatar/delivery",
		"PUT /api/v3/community/avatar/recovery",
		"POST /api/v3/voice/join", "POST /api/v3/voice/leave", "POST /api/v3/voice/{source}/disconnect/{session}",
		"POST /api/v3/policy/commit", "POST /api/v3/policy/channel-acl/{channel}",
		"POST /api/v3/policy/channel-acl/{channel}/personal", "POST /api/v3/policy/channel-settings/{channel}",
		"POST /api/v3/policy/channel-order", "POST /api/v3/policy/attestations", "POST /api/v3/ownership/accept",
		"POST /api/v3/member/leave", "POST /api/v3/moderation/member/{action}", "PUT /api/v3/moderation/timeout/{profile}",
		"POST /api/v3/devices/bind/apply", "POST /api/v3/recovery/device", "POST /api/v3/recovery/confirm",
		"POST /api/v3/profiles/link/apply", "POST /api/v3/profiles/unlink/apply", "POST /api/v3/invites/redeem":
		p.events.publish(memberEvent{Type: "state"})
	}
}
