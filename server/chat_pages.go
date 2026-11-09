package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// Keep the legacy endpoint stable; v2 clients explicitly request a bounded page.
func (a *app) chatPage(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authorizeChat(w, r); !ok {
		return
	}
	query := r.URL.Query()
	limit, err := strconv.Atoi(query.Get("limit"))
	if err != nil || limit < 1 || limit > 500 {
		fail(w, 400, "Invalid chat page size")
		return
	}
	cursors := map[string]int64{}
	for _, name := range []string{"after", "before", "around", "profilesAfter", "readAfter"} {
		if !query.Has(name) {
			continue
		}
		value, err := strconv.ParseInt(query.Get(name), 10, 64)
		if err != nil || value < 0 {
			fail(w, 400, "Invalid chat cursor")
			return
		}
		cursors[name] = value
	}
	if (cursors["after"] > 0 && (cursors["before"] > 0 || cursors["around"] > 0)) || (cursors["before"] > 0 && cursors["around"] > 0) {
		fail(w, 400, "Conflicting chat cursors")
		return
	}
	tx, err := a.chat.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	defer tx.Rollback()
	var first, last int64
	if err := tx.QueryRowContext(r.Context(), "SELECT COALESCE(MIN(id),0), COALESCE(MAX(id),0) FROM chat_messages WHERE feed = ?", a.chat.feed).Scan(&first, &last); err != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	sql := "SELECT id, request_id, author, author_id, sent, nonce, ciphertext, attachment_id FROM chat_messages WHERE feed = ?"
	args := []any{a.chat.feed}
	if query.Has("ids") {
		ids := strings.Split(query.Get("ids"), ",")
		if len(ids) > 500 {
			fail(w, 400, "Too many message IDs")
			return
		}
		marks := make([]string, len(ids))
		for i, raw := range ids {
			id, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || id <= 0 {
				fail(w, 400, "Invalid message ID")
				return
			}
			marks[i] = "?"
			args = append(args, id)
		}
		sql += " AND id IN (" + strings.Join(marks, ",") + ")"
	}
	switch {
	case cursors["after"] > 0:
		sql += " AND id > ? ORDER BY id ASC"
		args = append(args, cursors["after"])
	case cursors["before"] > 0:
		sql += " AND id < ? ORDER BY id DESC"
		args = append(args, cursors["before"])
	case cursors["around"] > 0:
		sql += " ORDER BY ABS(id - ?), id"
		args = append(args, cursors["around"])
	default:
		sql += " ORDER BY id DESC"
	}
	sql += " LIMIT ?"
	args = append(args, limit)
	rows, err := tx.QueryContext(r.Context(), sql, args...)
	if err != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	messages := []chatRecord{}
	for rows.Next() {
		var msg chatRecord
		if err := rows.Scan(&msg.ID, &msg.RequestID, &msg.Author, &msg.AuthorID, &msg.Sent, &msg.Nonce, &msg.Ciphertext, &msg.AttachmentID); err != nil {
			rows.Close()
			fail(w, 503, "Chat history unavailable")
			return
		}
		if msg.Nonce == nil {
			msg.Nonce = []byte{}
		}
		messages = append(messages, msg)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	sort.Slice(messages, func(i, j int) bool { return messages[i].ID < messages[j].ID })
	result := map[string]any{"first": first, "last": last, "messages": messages, "hasOlder": false, "hasNewer": false}
	if query.Has("ids") {
		encoded, err := json.Marshal(messages)
		if err != nil {
			fail(w, 503, "Chat history unavailable")
			return
		}
		hash := sha256.Sum256(encoded)
		digest := hex.EncodeToString(hash[:])
		if query.Get("digest") == digest {
			if tx.Commit() != nil {
				fail(w, 503, "Chat history unavailable")
				return
			}
			respond(w, 200, map[string]any{"unchanged": true, "digest": digest})
			return
		}
		result["digest"] = digest
	}
	if query.Has("readAfter") {
		var unread int
		if tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM chat_messages WHERE feed=? AND id>?", a.chat.feed, cursors["readAfter"]).Scan(&unread) != nil {
			fail(w, 503, "Chat history unavailable")
			return
		}
		result["unread"] = unread
	}
	if len(messages) > 0 {
		result["hasOlder"] = messages[0].ID > first
		result["hasNewer"] = messages[len(messages)-1].ID < last
	}
	if query.Has("profilesAfter") {
		profiles, err := readProfiles(r.Context(), tx, a.chat.feed, cursors["profilesAfter"])
		if err != nil {
			fail(w, 503, "Chat profiles unavailable")
			return
		}
		result["profiles"] = profiles
	}
	if tx.Commit() != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	respond(w, 200, result)
}
