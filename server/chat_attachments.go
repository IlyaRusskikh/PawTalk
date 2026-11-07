package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"time"
)

const attachmentLimit = 2*1024*1024 + 28 // file + optional AES-GCM IV and tag

var errChatAttachment = errors.New("chat attachment unavailable")

func validAttachmentID(id string) bool {
	raw, err := hex.DecodeString(id)
	return err == nil && len(raw) == 16 && hex.EncodeToString(raw) == id
}
func attachmentOwner(profileID, name string) string {
	if profileID != "" {
		return "id:" + profileID
	}
	return "name:" + name
}

func pruneAttachments(ctx context.Context, tx *sql.Tx, now time.Time) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM chat_attachments WHERE created <= ? AND NOT EXISTS (
	 SELECT 1 FROM chat_messages m WHERE m.feed = chat_attachments.feed AND m.attachment_id = chat_attachments.id)`, now.Add(-10*time.Minute).UnixMilli())
	return err
}

func (a *app) chatAttachment(w http.ResponseWriter, r *http.Request) {
	claims, ok := a.authorizeChat(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !validAttachmentID(id) {
		fail(w, 400, "Invalid attachment ID")
		return
	}
	if r.Method == http.MethodGet {
		var payload []byte
		err := a.chat.db.QueryRowContext(r.Context(), `SELECT payload FROM chat_attachments a WHERE a.feed=? AND a.id=? AND EXISTS (
	   SELECT 1 FROM chat_messages m WHERE m.feed=a.feed AND m.attachment_id=a.id)`, a.chat.feed, id).Scan(&payload)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 404, "Attachment unavailable")
			return
		}
		if err != nil {
			fail(w, 503, "Attachment unavailable")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(200)
		_, _ = w.Write(payload)
		return
	}
	if r.ContentLength > attachmentLimit {
		fail(w, 413, "Image exceeds 2 MB")
		return
	}
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, attachmentLimit))
	if err != nil || len(payload) == 0 {
		fail(w, 413, "Invalid attachment size")
		return
	}
	tx, err := a.chat.db.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, 503, "Attachment unavailable")
		return
	}
	defer tx.Rollback()
	owner := attachmentOwner(claims.ProfileID, claims.Name)
	var existing []byte
	var previousOwner string
	err = tx.QueryRowContext(r.Context(), "SELECT payload,owner FROM chat_attachments WHERE feed=? AND id=?", a.chat.feed, id).Scan(&existing, &previousOwner)
	if err == nil {
		if owner != previousOwner || !bytes.Equal(payload, existing) {
			fail(w, 409, "Attachment ID reused")
			return
		}
		respond(w, 200, map[string]string{"id": id})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		fail(w, 503, "Attachment unavailable")
		return
	}
	if pruneAttachments(r.Context(), tx, a.now()) != nil {
		fail(w, 503, "Attachment unavailable")
		return
	}
	var pending int64
	if tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM chat_attachments a WHERE feed=? AND owner=? AND NOT EXISTS (
 SELECT 1 FROM chat_messages m WHERE m.feed=a.feed AND m.attachment_id=a.id)`, a.chat.feed, owner).Scan(&pending) != nil {
		fail(w, 503, "Attachment unavailable")
		return
	}
	if pending >= 3 {
		fail(w, 429, "Too many pending attachments")
		return
	}
	if _, err = tx.ExecContext(r.Context(), "INSERT INTO chat_attachments(feed,id,owner,created,payload) VALUES (?,?,?,?,?)", a.chat.feed, id, owner, a.now().UnixMilli(), payload); err != nil {
		fail(w, 503, "Attachment unavailable")
		return
	}
	if err := a.chat.enforceStorage(r.Context(), tx, 0); err != nil {
		if errors.Is(err, errChatStorage) {
			fail(w, 507, "Attachment storage full")
		} else {
			fail(w, 503, "Attachment unavailable")
		}
		return
	}
	if tx.Commit() != nil {
		fail(w, 503, "Attachment unavailable")
		return
	}
	respond(w, 200, map[string]string{"id": id})
}
