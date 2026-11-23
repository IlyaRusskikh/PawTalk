package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
)

func EnsureChecklistSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_checklists (
		channel_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0), definition TEXT NOT NULL,
		PRIMARY KEY(channel_id,position)
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_checklist_state (
		channel_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0),
		revision INTEGER NOT NULL CHECK(revision>0), checked TEXT NOT NULL,
		PRIMARY KEY(channel_id,position)
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_checklist_receipts (
		device_id TEXT NOT NULL, operation_id TEXT NOT NULL, profile_id TEXT NOT NULL,
		channel_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0),
		item_id TEXT NOT NULL, checked INTEGER NOT NULL CHECK(checked IN (0,1)),
		PRIMARY KEY(device_id,operation_id)
	) STRICT`)
	return err
}

type MessageChecklist struct {
	Items    []string
	Everyone bool
}

func (definition *MessageChecklist) valid() bool {
	if definition == nil {
		return true
	}
	if len(definition.Items) < 1 || len(definition.Items) > 100 {
		return false
	}
	seen := make(map[string]bool, len(definition.Items))
	for _, id := range definition.Items {
		if len(id) != 32 || strings.Trim(id, "0123456789abcdef") != "" || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func (definition MessageChecklist) Digest() string {
	return hexHash([]byte("pawtalk-protected-checklist-v1:" + strconv.FormatBool(definition.Everyone) + ":" +
		strings.Join(definition.Items, ":")))
}

func insertMessageChecklist(ctx context.Context, tx *sql.Tx, attempt MessageAttempt, position uint64) error {
	if attempt.Checklist == nil {
		return nil
	}
	body, err := json.Marshal(attempt.Checklist)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO protected_checklists(channel_id,position,definition) VALUES(?,?,?)",
		attempt.ChannelID, position, string(body))
	return err
}

type ChecklistDefinition struct {
	Author   string
	Everyone bool
	Items    []string
	Checked  map[string]bool
}

func resolveMessageChecklist(ctx context.Context, query SessionQuery, imported ResolveChecklist, channel string, position uint64) (ChecklistDefinition, error) {
	var definition ChecklistDefinition
	var raw string
	err := query.QueryRowContext(ctx, `SELECT m.profile_id,c.definition FROM protected_checklists c
		JOIN protected_messages m ON m.channel_id=c.channel_id AND m.position=c.position
		WHERE c.channel_id=? AND c.position=?`, channel, position).Scan(&definition.Author, &raw)
	if errors.Is(err, sql.ErrNoRows) && imported != nil {
		return imported(ctx, query, channel, position)
	}
	if err != nil {
		return definition, err
	}
	var descriptor MessageChecklist
	err = json.Unmarshal([]byte(raw), &descriptor)
	definition.Items, definition.Everyone = descriptor.Items, descriptor.Everyone
	return definition, err
}

type ResolveChecklist func(context.Context, SessionQuery, string, uint64) (ChecklistDefinition, error)

type ChecklistState struct {
	Revision uint64          `json:"revision"`
	Checked  map[string]bool `json:"checked"`
	CanCheck bool            `json:"canCheck"`
}

type ChecklistChange struct {
	OperationID string `json:"operationId"`
	Item        string `json:"item"`
	Checked     bool   `json:"checked"`
}

func readChecklistState(ctx context.Context, query SessionQuery, channel string, position uint64, initial map[string]bool) (ChecklistState, error) {
	var current ChecklistState
	var raw string
	err := query.QueryRowContext(ctx, "SELECT revision,checked FROM protected_checklist_state WHERE channel_id=? AND position=?",
		channel, position).Scan(&current.Revision, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		current.Checked = initial
		err = nil
	} else if err == nil {
		err = json.Unmarshal([]byte(raw), &current.Checked)
	}
	if current.Checked == nil {
		current.Checked = make(map[string]bool)
	}
	return current, err
}

func saveChecklistState(ctx context.Context, tx *sql.Tx, channel string, position uint64, current ChecklistState) error {
	body, err := json.Marshal(current.Checked)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_checklist_state(channel_id,position,revision,checked) VALUES(?,?,?,?)
		ON CONFLICT(channel_id,position) DO UPDATE SET revision=excluded.revision,checked=excluded.checked`,
		channel, position, current.Revision, string(body))
	return err
}

func applyChecklistRevision(ctx context.Context, tx *sql.Tx, channel string, position uint64, initial ChecklistDefinition, next MessageChecklist) error {
	current, err := readChecklistState(ctx, tx, channel, position, initial.Checked)
	if err != nil {
		return err
	}
	for id := range current.Checked {
		if !slices.Contains(next.Items, id) {
			delete(current.Checked, id)
		}
	}
	current.Revision++
	return saveChecklistState(ctx, tx, channel, position, current)
}

func (s *Store) readChecklist(ctx context.Context, query SessionQuery, state State, actor Principal, lookup ResolveChecklist,
	channel string, position uint64) (ChecklistDefinition, ChecklistState, Decision, error) {
	if !state.PolicyAnchored || !state.canUseDevice(actor) || !state.CanDeliver(actor.ProfileID, channel, position) {
		return ChecklistDefinition{}, ChecklistState{}, ChannelRestricted, ChannelRestricted
	}
	definition, err := resolveMessageChecklist(ctx, query, lookup, channel, position)
	if errors.Is(err, sql.ErrNoRows) {
		err = ChannelRestricted
	}
	if err != nil {
		return definition, ChecklistState{}, ChannelRestricted, err
	}
	var latest sql.NullString
	err = query.QueryRowContext(ctx, `SELECT json_extract(record,'$.packet.checklist') FROM protected_text_revisions
		WHERE channel_id=? AND position=? ORDER BY revision DESC LIMIT 1`, channel, position).Scan(&latest)
	if err == nil {
		var edition *MessageChecklist
		if !latest.Valid || json.Unmarshal([]byte(latest.String), &edition) != nil || edition == nil || !edition.valid() {
			return definition, ChecklistState{}, ChannelRestricted, InvalidPolicy
		}
		definition.Everyone, definition.Items = edition.Everyone, edition.Items
	} else if !errors.Is(err, sql.ErrNoRows) {
		return definition, ChecklistState{}, ChannelRestricted, err
	}
	subject := state.Members[actor.ProfileID]
	timeout, err := readTimeout(ctx, query, subject)
	if err != nil {
		return definition, ChecklistState{}, ChannelRestricted, err
	}
	subject.TimeoutUntil = timeout.Deadline
	grant := state.CheckGrant(subject, state.scope(state.Channels[channel]), "checklist.check", s.now().UnixMilli())
	if grant == Allowed && !definition.Everyone && actor.ProfileID != definition.Author {
		grant = MissingGrant
	}
	current, err := readChecklistState(ctx, query, channel, position, definition.Checked)
	current.CanCheck = grant == Allowed
	return definition, current, grant, err
}

func (s *Store) DispatchChecklist(ctx context.Context, resolve ResolveSession, lookup ResolveChecklist,
	channel string, position uint64, deliver func(ChecklistState) error) error {
	if position == 0 || position >= math.MaxInt64 {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		_, current, _, err := s.readChecklist(ctx, conn, state, actor, lookup, channel, position)
		if err != nil {
			return err
		}
		return deliver(current)
	})
}

func (s *Store) ChangeChecklist(ctx context.Context, resolve ResolveSession, lookup ResolveChecklist,
	channel string, position uint64, change ChecklistChange) (ChecklistState, error) {
	if position == 0 || position >= math.MaxInt64 || len(change.OperationID) != 32 ||
		strings.Trim(change.OperationID, "0123456789abcdef") != "" || len(change.Item) != 32 ||
		strings.Trim(change.Item, "0123456789abcdef") != "" {
		return ChecklistState{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ChecklistState{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return ChecklistState{}, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return ChecklistState{}, err
	}
	definition, current, grant, err := s.readChecklist(ctx, tx, state, actor, lookup, channel, position)
	if err != nil {
		return ChecklistState{}, err
	}
	if grant != Allowed {
		return ChecklistState{}, grant
	}
	if !slices.Contains(definition.Items, change.Item) {
		return ChecklistState{}, InvalidAction
	}
	var priorChannel, priorItem, priorProfile string
	var priorPosition uint64
	var priorChecked bool
	err = tx.QueryRowContext(ctx, `SELECT profile_id,channel_id,position,item_id,checked FROM protected_checklist_receipts
		WHERE device_id=? AND operation_id=?`, actor.DeviceID, change.OperationID).
		Scan(&priorProfile, &priorChannel, &priorPosition, &priorItem, &priorChecked)
	if err == nil {
		if priorProfile != actor.ProfileID || priorChannel != channel || priorPosition != position || priorItem != change.Item || priorChecked != change.Checked {
			return ChecklistState{}, ErrMessageConflict
		}
		return current, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ChecklistState{}, err
	}
	if current.Checked[change.Item] != change.Checked {
		if change.Checked {
			current.Checked[change.Item] = true
		} else {
			delete(current.Checked, change.Item)
		}
		current.Revision++
		if err := saveChecklistState(ctx, tx, channel, position, current); err != nil {
			return ChecklistState{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_checklist_receipts(device_id,operation_id,profile_id,channel_id,position,item_id,checked)
		VALUES(?,?,?,?,?,?,?)`, actor.DeviceID, change.OperationID, actor.ProfileID, channel, position, change.Item, change.Checked); err != nil {
		return ChecklistState{}, err
	}
	return current, tx.Commit()
}
