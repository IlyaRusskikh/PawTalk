package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"sync"
)

const memberMessageColumns = `m.message_id,m.channel_id,m.author_profile_id,m.author_device_id,m.request_id,m.sent_at,m.edited_at,m.crypto_context_id,m.nonce,m.ciphertext,COALESCE((SELECT attachment_id FROM attachments a WHERE a.message_id=m.message_id),''),COALESCE((SELECT kind FROM system_messages sm WHERE sm.message_id=m.message_id),''),EXISTS(SELECT 1 FROM system_messages sm WHERE sm.message_id=m.message_id) OR EXISTS(SELECT 1 FROM polls p WHERE p.message_id=m.message_id AND p.closed_at IS NOT NULL)`

type memberDeleted struct {
	ID              int64  `json:"id"`
	AuthorProfileID string `json:"authorProfileId"`
	SystemKind      string `json:"systemKind,omitempty"`
}
type deliveryPlan struct {
	channel  string
	overflow bool
	previous int64
	ids      map[int64]bool
	deleted  []memberDeleted
	polls    map[string]bool
}
type messageDeliveries struct {
	mu    sync.Mutex
	plans map[*sql.Tx]map[string]*deliveryPlan
}

func (s *membershipStore) dropDeliveries(tx *sql.Tx) {
	s.deliveries.mu.Lock()
	delete(s.deliveries.plans, tx)
	s.deliveries.mu.Unlock()
}
func (s *membershipStore) trackDelivery(ctx context.Context, tx *sql.Tx, channel string, id int64, removed bool) error {
	if channel == "" {
		if err := tx.QueryRowContext(ctx, "SELECT channel_id FROM messages WHERE message_id=?", id).Scan(&channel); err != nil {
			return err
		}
	}
	s.deliveries.mu.Lock()
	defer s.deliveries.mu.Unlock()
	if s.deliveries.plans == nil {
		s.deliveries.plans = make(map[*sql.Tx]map[string]*deliveryPlan)
	}
	if s.deliveries.plans[tx] == nil {
		s.deliveries.plans[tx] = make(map[string]*deliveryPlan)
	}
	plan := s.deliveries.plans[tx][channel]
	if plan == nil {
		plan = &deliveryPlan{channel: channel, ids: make(map[int64]bool), polls: make(map[string]bool)}
		if err := tx.QueryRowContext(ctx, "SELECT message_revision FROM channels WHERE channel_id=?", channel).Scan(&plan.previous); err != nil {
			return err
		}
		s.deliveries.plans[tx][channel] = plan
	}
	if plan.overflow {
		return nil
	}
	if len(plan.ids)+len(plan.deleted) >= 32 {
		plan.overflow = true
		clear(plan.ids)
		plan.deleted = nil
		clear(plan.polls)
		return nil
	}
	if id > 0 {
		if removed {
			var d memberDeleted
			d.ID = id
			if err := tx.QueryRowContext(ctx, "SELECT author_profile_id,COALESCE((SELECT kind FROM system_messages WHERE message_id=?),'') FROM messages WHERE message_id=?", id, id).Scan(&d.AuthorProfileID, &d.SystemKind); err != nil {
				return err
			}
			plan.deleted = append(plan.deleted, d)
		} else {
			plan.ids[id] = true
		}
	}
	return nil
}
func (s *membershipStore) noteDelivery(tx *sql.Tx, channel string, id int64) {
	s.deliveries.mu.Lock()
	defer s.deliveries.mu.Unlock()
	plan := s.deliveries.plans[tx][channel]
	if plan.overflow {
		return
	}
	if len(plan.ids)+len(plan.deleted) >= 32 {
		plan.overflow = true
		clear(plan.ids)
		plan.deleted = nil
		clear(plan.polls)
		return
	}
	plan.ids[id] = true
}
func scanMemberMessage(row interface{ Scan(...any) error }) (memberMessage, error) {
	var v memberMessage
	var nonce, cipher []byte
	var attachment string
	err := row.Scan(&v.ID, &v.ChannelID, &v.AuthorProfileID, &v.AuthorDeviceID, &v.RequestID, &v.SentAt, &v.EditedAt, &v.KeyID, &nonce, &cipher, &attachment, &v.SystemKind, &v.Locked)
	v.Nonce = b64.EncodeToString(nonce)
	v.Ciphertext = b64.EncodeToString(cipher)
	v.AttachmentIDs = []string{}
	if attachment != "" {
		v.AttachmentIDs = append(v.AttachmentIDs, attachment)
	}
	return v, err
}

// Capture envelopes once inside the writing transaction. Publish only committed
// snapshots; the original author/request/key context is never rewritten.
func (s *membershipStore) commitDelivery(ctx context.Context, tx *sql.Tx) error {
	s.deliveries.mu.Lock()
	plans := s.deliveries.plans[tx]
	delete(s.deliveries.plans, tx)
	s.deliveries.mu.Unlock()
	events := make([]memberEvent, 0, len(plans))
	for _, plan := range plans {
		event := memberEvent{Type: "chat", ChannelID: plan.channel, Previous: plan.previous, Delivery: true, Deleted: plan.deleted, Messages: []memberMessage{}}
		for pollID := range plan.polls {
			event.PollIDs = append(event.PollIDs, pollID)
		}
		if err := tx.QueryRowContext(ctx, "SELECT message_revision,COALESCE((SELECT MIN(message_id) FROM messages WHERE channel_id=?),0),COALESCE((SELECT MAX(message_id) FROM messages WHERE channel_id=?),0) FROM channels WHERE channel_id=?", plan.channel, plan.channel, plan.channel).Scan(&event.Revision, &event.First, &event.Last); err != nil {
			return err
		}
		if plan.overflow || len(plan.ids)+len(plan.deleted) > 32 {
			events = append(events, memberEvent{Type: "resync"})
			continue
		}
		for id := range plan.ids {
			v, err := scanMemberMessage(tx.QueryRowContext(ctx, "SELECT "+memberMessageColumns+" FROM messages m WHERE m.message_id=?", id))
			if err == sql.ErrNoRows {
				event.Type = "resync"
				break
			}
			if err != nil {
				return err
			}
			event.Messages = append(event.Messages, v)
			var raw string
			if err := tx.QueryRowContext(ctx, "SELECT checked FROM checklists WHERE message_id=?", id).Scan(&raw); err == nil {
				checked := map[string]bool{}
				if err = json.Unmarshal([]byte(raw), &checked); err != nil {
					return err
				}
				event.Checklists = append(event.Checklists, memberChecklistUpdate{MessageID: id, Revision: event.Revision, Checked: checked})
			} else if err != sql.ErrNoRows {
				return err
			}
		}
		sort.Slice(event.Messages, func(i, j int) bool { return event.Messages[i].ID < event.Messages[j].ID })
		event.Rescan = len(event.Deleted) > 0
		for _, message := range event.Messages {
			if message.EditedAt != nil {
				event.Rescan = true
			}
		}
		data, _ := json.Marshal(event)
		if len(data) > 60000 {
			event = memberEvent{Type: "resync"}
		}
		events = append(events, event)
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, event := range events {
		s.events.publish(event)
	}
	return nil
}

func (s *membershipStore) notePollDelivery(tx *sql.Tx, channel, pollID string) {
	s.deliveries.mu.Lock()
	defer s.deliveries.mu.Unlock()
	plan := s.deliveries.plans[tx][channel]
	if !plan.overflow {
		plan.polls[pollID] = true
	}
}
