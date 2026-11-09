package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// The signed profile identity, never the display name, owns a retained message.
// Ciphertext stays opaque; edits must keep the message key and attachment.
func (a *app) chatMutate(w http.ResponseWriter, r *http.Request) {
	claims, ok := a.authorizeChat(w, r)
	if !ok {
		return
	}
	if claims.ProfileID == "" {
		fail(w, 403, "Verified profile required")
		return
	}
	var input struct {
		ID     int64       `json:"id"`
		Packet *chatPacket `json:"packet"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 18000))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || input.ID <= 0 {
		fail(w, 400, "Invalid message mutation")
		return
	}
	tx, err := a.chat.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 503, "Chat storage unavailable")
		return
	}
	defer tx.Rollback()
	var owner, key, attachment string
	err = tx.QueryRowContext(r.Context(), "SELECT author_id, request_id, attachment_id FROM chat_messages WHERE feed=? AND id=?", a.chat.feed, input.ID).Scan(&owner, &key, &attachment)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "Message unavailable")
		return
	}
	if err != nil {
		fail(w, 503, "Chat storage unavailable")
		return
	}
	if owner != claims.ProfileID {
		fail(w, 403, "Message belongs to another profile")
		return
	}
	if p := input.Packet; p != nil {
		valid := len(p.Ciphertext) > 0 && len(p.Ciphertext) <= 12304 && ((!a.cfg.RequireE2EE && len(p.Nonce) == 0) || (len(p.Nonce) == 12 && len(p.Ciphertext) > 16))
		if !valid || p.RequestID != key || p.AttachmentID != attachment {
			fail(w, 400, "Invalid edit packet")
			return
		}
		_, err = tx.ExecContext(r.Context(), "UPDATE chat_messages SET nonce=?, ciphertext=? WHERE feed=? AND id=?", p.Nonce, p.Ciphertext, a.chat.feed, input.ID)
		if err == nil {
			err = a.chat.enforceStorage(r.Context(), tx, input.ID)
		}
	} else {
		_, err = tx.ExecContext(r.Context(), "DELETE FROM chat_messages WHERE feed=? AND id=?", a.chat.feed, input.ID)
		if err == nil && attachment != "" {
			_, err = tx.ExecContext(r.Context(), `DELETE FROM chat_attachments WHERE feed=? AND id=? AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE feed=? AND attachment_id=?)`, a.chat.feed, attachment, a.chat.feed, attachment)
		}
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 503, "Chat storage unavailable")
		return
	}
	respond(w, 200, map[string]int64{"id": input.ID})
}
