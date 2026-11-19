package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
)

type memberChecklistDefinition struct {
	Items    []string `json:"items"`
	Everyone bool     `json:"everyone"`
}

func setChecklistTx(ctx context.Context, tx *sql.Tx, id int64, def *memberChecklistDefinition) error {
	if def == nil {
		_, err := tx.ExecContext(ctx, "DELETE FROM checklists WHERE message_id=?", id)
		return err
	}
	if len(def.Items) < 1 || len(def.Items) > 100 {
		return memberError(400, "INVALID_CHECKLIST")
	}
	seen := map[string]bool{}
	for _, item := range def.Items {
		if !validHexID(item, 32) || seen[item] {
			return memberError(400, "INVALID_CHECKLIST")
		}
		seen[item] = true
	}
	checked := map[string]bool{}
	var old string
	err := tx.QueryRowContext(ctx, "SELECT checked FROM checklists WHERE message_id=?", id).Scan(&old)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if old != "" {
		if err = json.Unmarshal([]byte(old), &checked); err != nil {
			return err
		}
	}
	for item := range checked {
		if !seen[item] {
			delete(checked, item)
		}
	}
	ids, _ := json.Marshal(def.Items)
	done, _ := json.Marshal(checked)
	_, err = tx.ExecContext(ctx, "INSERT INTO checklists(message_id,item_ids,checked,everyone) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET item_ids=excluded.item_ids,checked=excluded.checked,everyone=excluded.everyone", id, string(ids), string(done), def.Everyone)
	return err
}

func (a *membershipAPI) checklist(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		memberFail(w, memberError(400, "INVALID_MESSAGE"))
		return
	}
	var input struct {
		Item      string `json:"item"`
		Checked   bool   `json:"checked"`
		RequestID string `json:"requestId"`
	}
	if r.Method == "PUT" {
		if _, err = decodeMemberJSON(w, r, 512, &input); err != nil {
			memberFail(w, err)
			return
		}
	}
	var revision int64
	read := func(tx *sql.Tx, access memberAccess) (map[string]bool, error) {
		if !access.allows("chat.read") {
			return nil, memberError(403, "FORBIDDEN")
		}
		var ids, raw, author, channel string
		var everyone bool
		err := tx.QueryRowContext(r.Context(), "SELECT c.item_ids,c.checked,c.everyone,m.author_profile_id,m.channel_id,ch.message_revision FROM checklists c JOIN messages m ON m.message_id=c.message_id JOIN channels ch ON ch.channel_id=m.channel_id WHERE c.message_id=?", id).Scan(&ids, &raw, &everyone, &author, &channel, &revision)
		if err == sql.ErrNoRows {
			return nil, memberError(404, "MESSAGE_NOT_FOUND")
		}
		if err != nil {
			return nil, err
		}
		checked := map[string]bool{}
		if err = json.Unmarshal([]byte(raw), &checked); err != nil {
			return nil, err
		}
		if r.Method == "PUT" {
			root, err := resolvedProfileTx(r.Context(), tx, author)
			if err != nil {
				return nil, err
			}
			if !everyone && root != access.EffectiveProfileID {
				return nil, memberError(403, "FORBIDDEN")
			}
			var items []string
			if err = json.Unmarshal([]byte(ids), &items); err != nil {
				return nil, err
			}
			if !slices.Contains(items, input.Item) {
				return nil, memberError(409, "INVALID_CHECKLIST_ITEM")
			}
			if input.Checked {
				checked[input.Item] = true
			} else {
				delete(checked, input.Item)
			}
			if err = a.store.trackChecklist(r.Context(), tx, channel, id); err != nil {
				return nil, err
			}
			revision++
			raw, _ := json.Marshal(checked)
			if _, err = tx.ExecContext(r.Context(), "UPDATE checklists SET checked=? WHERE message_id=?", string(raw), id); err != nil {
				return nil, err
			}
		}
		return checked, nil
	}
	var checked map[string]bool
	if r.Method == "PUT" {
		payload, _ := json.Marshal(input)
		err = a.store.mutate(r.Context(), memberBearer(r), input.RequestID, "checklist.check", "chat.write", payload, func(tx *sql.Tx, access memberAccess) error { var e error; checked, e = read(tx, access); return e })
	} else {
		tx, e := a.store.db.BeginTx(r.Context(), nil)
		if e != nil {
			memberFail(w, e)
			return
		}
		defer tx.Rollback()
		access, e := a.store.sessionAccessTx(r.Context(), tx, memberBearer(r))
		if e == nil {
			checked, e = read(tx, access)
		}
		err = e
	}
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]any{"checked": checked, "revision": revision})
}

func (s *membershipStore) trackChecklist(ctx context.Context, tx *sql.Tx, channel string, id int64) error {
	if err := s.trackDelivery(ctx, tx, channel, id, false); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "UPDATE channels SET message_revision=message_revision+1 WHERE channel_id=?", channel)
	return err
}
