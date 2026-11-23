package access

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
	"time"
)

const mentionPresenceLifetime = 25 * time.Second
const mentionAlertLifetime = 30 * time.Second
const mentionAlertPageSize = 32

type MentionAlert struct {
	ChannelID string `json:"channelId"`
	Position  uint64 `json:"position"`
	Kind      string `json:"kind"`
}

type MentionInbox struct {
	Alerts []MentionAlert `json:"alerts"`
	Cursor string         `json:"cursor,omitempty"`
	More   bool           `json:"more,omitempty"`
}

type MentionEligibility struct {
	Kind      string `json:"kind"`
	Remaining int64  `json:"remaining"`
	Revision  uint64 `json:"revision"`
}

func (s *Store) DispatchMentionEligibility(ctx context.Context, resolve ResolveSession, channelID string, position uint64,
	deliver func(MentionEligibility) error) error {
	return s.dispatchHistory(ctx, resolve, channelID, func(conn *sql.Conn, _ State, principal Principal, first, next uint64) error {
		if position < first || position >= next {
			return ChannelRestricted
		}
		var result MentionEligibility
		var sentAt int64
		now := s.now().UnixMilli()
		err := conn.QueryRowContext(ctx, `SELECT a.kind,a.sent_at,COALESCE((SELECT MAX(r.revision) FROM protected_text_revisions r
			WHERE r.channel_id=a.channel_id AND r.position=a.position),1) FROM protected_mention_alerts a
			WHERE a.channel_id=? AND a.position=? AND a.profile_id=? AND a.sent_at>?`, channelID, position, principal.ProfileID,
			now-mentionAlertLifetime.Milliseconds()).Scan(&result.Kind, &sentAt, &result.Revision)
		if errors.Is(err, sql.ErrNoRows) {
			return ChannelRestricted
		}
		if err != nil {
			return err
		}
		result.Remaining = min(mentionAlertLifetime.Milliseconds(), sentAt+mentionAlertLifetime.Milliseconds()-now)
		return deliver(result)
	})
}

func insertMentionAlerts(ctx context.Context, tx *sql.Tx, state State, author Principal, attempt MessageAttempt, position uint64, now int64) error {
	direct, roles := map[string]bool{}, map[string]bool{}
	var everyone, online bool
	for _, target := range attempt.MentionRouting.Targets {
		switch target.Kind {
		case "profile":
			direct[target.ID] = true
		case "role":
			roles[target.ID] = true
		case "everyone":
			everyone = true
		case "online":
			online = true
		}
	}
	var present map[string]bool
	if online && !everyone {
		var err error
		present, err = readMentionPresence(ctx, tx, state, now)
		if err != nil {
			return err
		}
	}
	if err := pruneMentionAlerts(ctx, tx, now); err != nil {
		return err
	}
	statement, err := tx.PrepareContext(ctx, `INSERT INTO protected_mention_alerts(cursor,channel_id,position,profile_id,kind,sent_at)
		VALUES(lower(hex(randomblob(16))),?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer statement.Close()
	for profileID, member := range state.Members {
		if profileID == author.ProfileID || !state.CanDeliver(profileID, attempt.ChannelID, 0) ||
			!state.Admissions[attempt.ChannelID][profileID].CanRead(position, false) {
			continue
		}
		kind := "group"
		if direct[profileID] {
			kind = "direct"
		} else if !everyone && !present[profileID] && !slices.ContainsFunc(member.Roles, func(role string) bool { return roles[role] }) {
			continue
		}
		if _, err := statement.ExecContext(ctx, attempt.ChannelID, position, profileID, kind, now); err != nil {
			return err
		}
	}
	return nil
}

func readMentionPresence(ctx context.Context, tx *sql.Tx, state State, now int64) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT device_id,profile_id FROM protected_mention_presence WHERE touched_at>?`,
		now-mentionPresenceLifetime.Milliseconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	present := map[string]bool{}
	for rows.Next() {
		var principal Principal
		if err := rows.Scan(&principal.DeviceID, &principal.ProfileID); err != nil {
			return nil, err
		}
		if state.canUseDevice(principal) {
			present[principal.ProfileID] = true
		}
	}
	return present, rows.Err()
}

func pruneMentionAlerts(ctx context.Context, tx *sql.Tx, now int64) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM protected_mention_alerts WHERE sent_at<=?`, now-mentionAlertLifetime.Milliseconds())
	return err
}

// DispatchMentionInbox records authenticated activity and delivers only alerts
// whose original remains in the recipient's current admission interval. The
// immediate transaction holds the policy stable through the bounded write.
func (s *Store) DispatchMentionInbox(ctx context.Context, resolve ResolveSession, after string, deliver func(MentionInbox) error) error {
	if after != "" && (len(after) != 32 || strings.Trim(after, "0123456789abcdef") != "") {
		return InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	principal, err := resolve(ctx, tx)
	if err != nil {
		return err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	if !state.PolicyAnchored || !state.canUseDevice(principal) || !state.Members[principal.ProfileID].Active {
		return ChannelRestricted
	}
	now := s.now().UnixMilli()
	if err := pruneMentionAlerts(ctx, tx, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM protected_mention_presence WHERE touched_at<=?`, now-mentionPresenceLifetime.Milliseconds()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_mention_presence(device_id,profile_id,touched_at) VALUES(?,?,?)
		ON CONFLICT(device_id) DO UPDATE SET profile_id=excluded.profile_id,touched_at=excluded.touched_at`,
		principal.DeviceID, principal.ProfileID, now); err != nil {
		return err
	}
	page, err := readMentionInbox(ctx, tx, state, principal.ProfileID, after)
	if err != nil {
		return err
	}
	if err := deliver(page); err != nil {
		return err
	}
	return tx.Commit()
}

func readMentionInbox(ctx context.Context, tx *sql.Tx, state State, profileID string, after string) (MentionInbox, error) {
	page := MentionInbox{Alerts: []MentionAlert{}}
	var sequence int64
	if after != "" {
		err := tx.QueryRowContext(ctx, `SELECT sequence FROM protected_mention_alerts WHERE profile_id=? AND cursor=?`, profileID, after).Scan(&sequence)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return page, err
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT channel_id,position,kind,cursor FROM protected_mention_alerts WHERE profile_id=? AND sequence>? ORDER BY sequence`,
		profileID, sequence)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var alert MentionAlert
		var cursor string
		if err := rows.Scan(&alert.ChannelID, &alert.Position, &alert.Kind, &cursor); err != nil {
			return page, err
		}
		if !state.CanDeliver(profileID, alert.ChannelID, alert.Position) {
			continue
		}
		if len(page.Alerts) == mentionAlertPageSize {
			page.More = true
			break
		}
		page.Alerts = append(page.Alerts, alert)
		page.Cursor = cursor
	}
	return page, rows.Err()
}
