package access

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
)

const auditSchema = `
CREATE TABLE IF NOT EXISTS protected_audit_config (
	id INTEGER PRIMARY KEY CHECK(id=1),
	days INTEGER NOT NULL CHECK(days>0)
) STRICT;
INSERT OR IGNORE INTO protected_audit_config(id,days) VALUES(1,365);
CREATE TABLE IF NOT EXISTS protected_audit_events (
	sequence INTEGER PRIMARY KEY,
	cursor TEXT NOT NULL UNIQUE CHECK(length(cursor)=32),
	occurred_at INTEGER NOT NULL,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	kind TEXT NOT NULL,
	object_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	category_id TEXT NOT NULL,
	position INTEGER NOT NULL,
	reason TEXT NOT NULL,
	change BLOB NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS protected_audit_expiry ON protected_audit_events(occurred_at);`

const auditPageSize = 32
const millisecondsPerDay int64 = 24 * 60 * 60 * 1000

var ErrAuditRetentionChanged = errors.New("protected audit retention changed")
var ErrAuditRetentionConfirmation = errors.New("shorter audit retention requires confirmation")
var ErrAuditCursor = errors.New("protected audit cursor no longer available")

type AuditChange struct {
	Previous     *int64   `json:"previous,omitempty"`
	Current      *int64   `json:"current,omitempty"`
	Added        []string `json:"added,omitempty"`
	Removed      []string `json:"removed,omitempty"`
	LayoutDigest string   `json:"layoutDigest,omitempty"`
	ObjectName   string   `json:"objectName,omitempty"`
}

type AuditEvent struct {
	At          int64             `json:"at"`
	Actor       string            `json:"actor"`
	ActorName   string            `json:"actorName,omitempty"`
	Action      string            `json:"action"`
	Kind        string            `json:"kind"`
	ObjectID    string            `json:"objectId"`
	ObjectName  string            `json:"objectName,omitempty"`
	ChannelID   string            `json:"channelId,omitempty"`
	ChannelName string            `json:"channelName,omitempty"`
	RoleNames   map[string]string `json:"roleNames,omitempty"`
	Position    uint64            `json:"position,omitempty"`
	Reason      string            `json:"reason,omitempty"`
	Change      AuditChange       `json:"change"`
	category    string
}

type AuditPage struct {
	Entries   []AuditEvent `json:"entries"`
	Next      string       `json:"next,omitempty"`
	Retention int64        `json:"retention"`
	CanChange bool         `json:"canChange"`
	Scope     string       `json:"scope"`
	Cutoff    int64        `json:"cutoff"`
}

func recordAudit(ctx context.Context, tx *sql.Tx, event AuditEvent) error {
	var cursor [16]byte
	if _, err := rand.Read(cursor[:]); err != nil {
		return err
	}
	// Encode only the typed projection. Policy frames, encrypted content and
	// operation parameters are deliberately unavailable to the journal.
	change, err := json.Marshal(event.Change)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_audit_events
		(cursor,occurred_at,actor,action,kind,object_id,channel_id,category_id,position,reason,change)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`, hex.EncodeToString(cursor[:]), event.At, event.Actor, event.Action, event.Kind,
		event.ObjectID, event.ChannelID, event.category, event.Position, event.Reason, change)
	return err
}

func EnsureAuditSchema(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, auditSchema); err != nil {
		return err
	}
	// Earlier handover events put the owner profile in the channel fields.
	// Preserve it as the affected profile when no target device was recorded.
	if _, err := tx.ExecContext(ctx, `UPDATE protected_audit_events SET kind='member', channel_id=''
		WHERE action=? AND kind='channel' AND channel_id=object_id
		AND length(object_id)=64 AND object_id NOT GLOB '*[^0-9a-f]*'`, MoveScopeDevice); err != nil {
		return err
	}
	return importTimeoutAudit(ctx, tx)
}

func readAuditRetention(ctx context.Context, q SessionQuery) (int64, error) {
	var days int64
	err := q.QueryRowContext(ctx, "SELECT days FROM protected_audit_config WHERE id=1").Scan(&days)
	return days, err
}

func auditPrivilege(state State, actor Principal, now int64) (allowed, admin bool) {
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) {
		return false, false
	}
	subject := state.Members[actor.ProfileID]
	return state.CheckGrant(subject, Scope{}, "audit.view", now) == Allowed,
		state.CheckGrant(subject, Scope{}, Administrator, now) == Allowed
}

type AuditNames struct {
	Member          func(context.Context, SessionQuery, string) (string, error)
	Channels, Roles map[string]string
}

func (s *Store) DispatchAudit(ctx context.Context, resolve ResolveSession, before string, hasImported bool, deliver func(AuditPage) error) error {
	return s.DispatchAuditWithNames(ctx, resolve, before, hasImported, AuditNames{}, deliver)
}

func (s *Store) DispatchAuditWithNames(ctx context.Context, resolve ResolveSession, before string, hasImported bool, names AuditNames, deliver func(AuditPage) error) error {
	if before != "" && !validRotationID(before) {
		return InvalidAction
	}
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		now := s.now().UnixMilli()
		allowed, admin := auditPrivilege(state, actor, now)
		if !allowed {
			return MissingGrant
		}
		days, err := readAuditRetention(ctx, conn)
		if err != nil {
			return err
		}
		channels, categories := "{}", "{}"
		if !admin {
			channels, categories = auditScopes(state, actor.ProfileID)
		}
		scopeData := channels + "\x00" + categories
		if admin {
			scopeData = "administrator"
		}
		scope := sha256.Sum256([]byte(scopeData))
		cutoff := now - days*millisecondsPerDay
		page := AuditPage{Entries: make([]AuditEvent, 0, auditPageSize), Retention: days, CanChange: admin,
			Scope: hex.EncodeToString(scope[:]), Cutoff: max(0, cutoff)}
		filter := pollResultEventFilter("e", "ch.first", hasImported)
		// Cursor lookup and page delivery use the same current scope. Rows
		// outside it cannot affect pagination even after a change in access.
		visible := `WITH channels AS (SELECT key AS id, value AS first FROM json_each(?)),
			categories AS (SELECT key AS id FROM json_each(?)), visible AS (
			SELECT e.* FROM protected_audit_events e
			LEFT JOIN channels ch ON ch.id=e.channel_id
			LEFT JOIN categories cat ON e.channel_id='' AND cat.id=e.category_id
			WHERE e.occurred_at>=? AND (? OR CASE
				WHEN e.channel_id<>'' THEN ch.id IS NOT NULL AND (e.position=0 OR (ch.first>0 AND e.position>=ch.first` + filter + `))
				WHEN e.category_id<>'' THEN cat.id IS NOT NULL
				ELSE 1 END)
			)`
		var boundary, boundaryTime sql.NullInt64
		if before != "" {
			err := conn.QueryRowContext(ctx, visible+`SELECT sequence,occurred_at FROM visible WHERE cursor=?`,
				channels, categories, cutoff, admin, before).Scan(&boundary, &boundaryTime)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrAuditCursor
			}
			if err != nil {
				return err
			}
		}
		rows, err := conn.QueryContext(ctx, visible+`
			SELECT cursor,occurred_at,actor,action,kind,object_id,channel_id,position,reason,change
			FROM visible WHERE (? IS NULL OR (occurred_at,sequence)<(?,?))
			ORDER BY occurred_at DESC,sequence DESC LIMIT ?`,
			channels, categories, cutoff, admin, boundary, boundaryTime, boundary, auditPageSize+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		var cursor string
		for rows.Next() {
			if len(page.Entries) == auditPageSize {
				page.Next = cursor
				break
			}
			var event AuditEvent
			var change []byte
			if err := rows.Scan(&cursor, &event.At, &event.Actor, &event.Action, &event.Kind, &event.ObjectID, &event.ChannelID,
				&event.Position, &event.Reason, &change); err != nil {
				return err
			}
			if err := json.Unmarshal(change, &event.Change); err != nil {
				return err
			}
			page.Entries = append(page.Entries, event)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		memberNames := make(map[string]string)
		memberName := func(id string) (string, error) {
			if name, found := memberNames[id]; found {
				return name, nil
			}
			if names.Member == nil || id == "" {
				return "", nil
			}
			name, err := names.Member(ctx, conn, id)
			memberNames[id] = name
			return name, err
		}
		roleName := func(id string) string {
			if name := state.RolePresentation[id].Name; name != "" {
				return name
			}
			return names.Roles[id]
		}
		channelName := func(id string) string {
			if channel := state.Channels[id]; channel.Settings != nil {
				return channel.Settings.Name
			}
			return names.Channels[id]
		}
		for i := range page.Entries {
			event := &page.Entries[i]
			event.ActorName, err = memberName(event.Actor)
			if err != nil {
				return err
			}
			event.ChannelName = channelName(event.ChannelID)
			event.ObjectName = event.Change.ObjectName
			switch event.Kind {
			case "member":
				// A nickname edit records who was affected without returning the edited name.
				if event.Action != "profile.edit-other" && event.Action != "profile.edit-self" {
					event.ObjectName, err = memberName(event.ObjectID)
					if err != nil {
						return err
					}
				}
			case "channel":
				if event.ObjectName == "" {
					event.ObjectName = channelName(event.ObjectID)
				}
			case "category":
				if event.ObjectName == "" {
					event.ObjectName = state.CategoryNames[event.ObjectID]
				}
			case "role":
				if event.ObjectName == "" {
					event.ObjectName = roleName(event.ObjectID)
				}
			}
			if event.Action == "role.assign" {
				event.RoleNames = make(map[string]string)
				for _, ids := range [][]string{event.Change.Added, event.Change.Removed} {
					for _, id := range ids {
						if name := roleName(id); name != "" {
							event.RoleNames[id] = name
						}
					}
				}
			}
		}
		return deliver(page)
	})
}

func auditScopes(state State, profile string) (string, string) {
	first := make(map[string]uint64)
	categories := make(map[string]bool)
	subject := state.Members[profile]
	for id, channel := range state.Channels {
		if !state.CanDeliver(profile, id, 0) {
			continue
		}
		first[id] = 0
		if channel.Kind == "text" {
			first[id] = state.Admissions[id][profile].FirstPosition
			if first[id] != 0 && state.CheckGrant(subject, state.scope(channel), "history.full", 0) == Allowed {
				first[id] = 1
			}
		}
		if channel.CategoryID != "" {
			categories[channel.CategoryID] = true
		}
	}
	// Only strings, booleans and uint64 values appear in these maps.
	channelJSON, _ := json.Marshal(first)
	categoryJSON, _ := json.Marshal(categories)
	return string(channelJSON), string(categoryJSON)
}

type AuditRetentionRequest struct {
	Days           int64 `json:"days"`
	Expected       int64 `json:"expected"`
	ConfirmShorter bool  `json:"confirmShorter"`
}

func (s *Store) ChangeAuditRetention(ctx context.Context, resolve ResolveSession, request AuditRetentionRequest) error {
	if request.Days < 1 || request.Days > math.MaxInt64/millisecondsPerDay || request.Expected < 1 {
		return InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	now := s.now().UnixMilli()
	if _, admin := auditPrivilege(state, actor, now); !admin {
		return MissingGrant
	}
	current, err := readAuditRetention(ctx, tx)
	if err != nil {
		return err
	}
	if current == request.Days {
		return nil
	}
	if current != request.Expected {
		return ErrAuditRetentionChanged
	}
	if request.Days < current && !request.ConfirmShorter {
		return ErrAuditRetentionConfirmation
	}
	if _, err := tx.ExecContext(ctx, "UPDATE protected_audit_config SET days=? WHERE id=1", request.Days); err != nil {
		return err
	}
	if err := purgeAudit(ctx, tx, now, min(current, request.Days)); err != nil {
		return err
	}
	if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: "audit.retention", Kind: "server",
		Change: AuditChange{Previous: &current, Current: &request.Days}}); err != nil {
		return err
	}
	return tx.Commit()
}

func purgeAudit(ctx context.Context, tx *sql.Tx, now, days int64) error {
	_, err := tx.ExecContext(ctx, "DELETE FROM protected_audit_events WHERE occurred_at<?", now-days*millisecondsPerDay)
	return err
}

func (s *Store) PruneAudit(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	days, err := readAuditRetention(ctx, tx)
	if err != nil {
		return err
	}
	if err := purgeAudit(ctx, tx, s.now().UnixMilli(), days); err != nil {
		return err
	}
	return tx.Commit()
}
