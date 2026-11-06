package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type profileUpdate struct {
	Nickname   string `json:"nickname"`
	Nonce      []byte `json:"nonce"`
	Ciphertext []byte `json:"ciphertext"`
}

type chatProfileRecord struct {
	profileUpdate
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}

func (a *app) chatProfile(w http.ResponseWriter, r *http.Request) {
	claims, ok := a.authorizeChat(w, r)
	if !ok {
		return
	}
	if claims.ProfileID == "" {
		fail(w, 403, "A verified profile is required")
		return
	}
	var update profileUpdate
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 17000))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&update) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		fail(w, 400, "Invalid profile")
		return
	}
	update.Nickname = strings.TrimSpace(update.Nickname)
	noAvatar := len(update.Nonce) == 0 && len(update.Ciphertext) == 0
	validAvatar := len(update.Nonce) == 12 && len(update.Ciphertext) > 16 && len(update.Ciphertext) <= 12016
	if !validNickname(update.Nickname) || (!noAvatar && !validAvatar) {
		fail(w, 400, "Invalid profile")
		return
	}
	if err := a.chat.saveProfile(r.Context(), claims.ProfileID, update, a.now()); err != nil {
		fail(w, 503, "Chat profile unavailable")
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}

func (s *chatStore) saveProfile(ctx context.Context, id string, update profileUpdate, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO chat_profiles(feed, profile_id, nickname, nonce, ciphertext, updated)
		VALUES (?, ?, ?, ?, ?, ?)`, s.feed, id, update.Nickname, update.Nonce, update.Ciphertext, now.UnixMilli()); err != nil {
		return err
	}
	if err := pruneProfiles(ctx, tx, now); err != nil {
		return err
	}
	return tx.Commit()
}

func pruneProfiles(ctx context.Context, tx *sql.Tx, now time.Time) error {
	// Retain all authors of stored messages and a small cache of profiles
	// that have not sent a message yet.
	_, err := tx.ExecContext(ctx, `
		DELETE FROM chat_profiles WHERE revision IN (
			SELECT revision FROM chat_profiles p WHERE NOT EXISTS (
				SELECT 1 FROM chat_messages m WHERE m.feed = p.feed AND m.author_id = p.profile_id
			) AND (p.updated <= ? OR p.revision IN (
				SELECT revision FROM chat_profiles idle WHERE NOT EXISTS (
					SELECT 1 FROM chat_messages m WHERE m.feed = idle.feed AND m.author_id = idle.profile_id
				) ORDER BY revision DESC LIMIT -1 OFFSET 64
			))
		)`, now.Add(-chatRetention).UnixMilli())
	return err
}

func readProfiles(ctx context.Context, tx *sql.Tx, feed string, after int64) ([]chatProfileRecord, error) {
	rows, err := tx.QueryContext(ctx, `SELECT profile_id, revision, nickname, nonce, ciphertext
		FROM chat_profiles WHERE feed = ? AND revision > ? ORDER BY revision`, feed, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	profiles := []chatProfileRecord{}
	for rows.Next() {
		var profile chatProfileRecord
		if err := rows.Scan(&profile.ID, &profile.Revision, &profile.Nickname, &profile.Nonce, &profile.Ciphertext); err != nil {
			return nil, err
		}
		profiles = append(profiles, profile)
	}
	return profiles, rows.Err()
}
