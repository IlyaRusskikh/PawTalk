package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const profileIdleRetention = 7 * 24 * time.Hour

type chatStore struct {
	db        *sql.DB
	feed      string
	ephemeral bool
	maxBytes  int64
}

func startRoomChat(path string, required bool, fingerprint string) (*chatStore, func(), error) {
	if required && fingerprint == "" {
		return nil, func() {}, nil
	}
	if !required {
		fingerprint = "transport-only-v2"
	}
	limit := int64(defaultChatStorage)
	if path != ":memory:" {
		var err error
		limit, err = chatStorageLimit()
		if err != nil {
			return nil, nil, err
		}
	}
	store, err := openChat(path, fingerprint, time.Now(), limit)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		store.cleanPeriodically(ctx)
	}()
	return store, func() {
		cancel()
		<-done
		_ = store.db.Close()
	}, nil
}

func openChat(path, fingerprint string, now time.Time, limits ...int64) (*chatStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	limit := int64(defaultChatStorage)
	if len(limits) > 0 {
		limit = limits[0]
	}
	if limit < 0 {
		db.Close()
		return nil, errors.New("invalid chat storage limit")
	}
	store := &chatStore{db: db, ephemeral: path == ":memory:", maxBytes: limit}
	var vacuum int
	if err := db.QueryRow("PRAGMA auto_vacuum").Scan(&vacuum); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec("PRAGMA auto_vacuum=FULL"); err != nil {
		db.Close()
		return nil, err
	}
	if err := store.initialize(fingerprint, now); err != nil {
		db.Close()
		return nil, err
	}
	if vacuum != 1 && !store.ephemeral {
		if _, err := db.Exec("VACUUM"); err != nil {
			db.Close()
			return nil, err
		}
	}
	return store, nil
}

func (s *chatStore) initialize(fingerprint string, now time.Time) error {
	// Keep the active key and feed in the same transaction. AUTOINCREMENT
	// keeps a cursor unambiguous even after every old message has expired.
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var columns, authorIDs int
	if err := tx.QueryRow("SELECT COUNT(*), COUNT(CASE WHEN name = 'author_id' THEN 1 END) FROM pragma_table_info('chat_messages')").Scan(&columns, &authorIDs); err != nil {
		return err
	}
	// Chat has not shipped yet. Start a fresh feed for the earlier preview schema.
	if columns > 0 && authorIDs == 0 {
		if _, err := tx.Exec("DROP TABLE chat_messages; DROP TABLE chat_state;"); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS chat_state (
			id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL, feed TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS chat_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT, feed TEXT NOT NULL, request_id TEXT NOT NULL,
			author TEXT NOT NULL, author_id TEXT NOT NULL DEFAULT '', sent INTEGER NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL,
			UNIQUE(feed, request_id)
		);
		CREATE INDEX IF NOT EXISTS chat_feed_cursor ON chat_messages(feed, id);
		CREATE INDEX IF NOT EXISTS chat_message_author ON chat_messages(feed, author_id);
		CREATE TABLE IF NOT EXISTS chat_profiles (
			revision INTEGER PRIMARY KEY AUTOINCREMENT, feed TEXT NOT NULL, profile_id TEXT NOT NULL,
			nickname TEXT NOT NULL, nonce BLOB, ciphertext BLOB, updated INTEGER NOT NULL,
			UNIQUE(feed, profile_id)
		);
	`); err != nil {
		return err
	}
	var attachmentColumns int
	if err := tx.QueryRow("SELECT COUNT(*) FROM pragma_table_info('chat_messages') WHERE name = 'attachment_id'").Scan(&attachmentColumns); err != nil {
		return err
	}
	if attachmentColumns == 0 {
		if _, err := tx.Exec("ALTER TABLE chat_messages ADD COLUMN attachment_id TEXT NOT NULL DEFAULT ''"); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS chat_attachments (
		feed TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, created INTEGER NOT NULL, payload BLOB NOT NULL,
		PRIMARY KEY(feed, id)); CREATE INDEX IF NOT EXISTS chat_attachment_created ON chat_attachments(created);`); err != nil {
		return err
	}
	var previous string
	err = tx.QueryRow("SELECT fingerprint, feed FROM chat_state WHERE id = 1").Scan(&previous, &s.feed)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if previous != fingerprint {
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return err
		}
		s.feed = hex.EncodeToString(random[:])
		if _, err := tx.Exec("INSERT OR REPLACE INTO chat_state VALUES (1, ?, ?)", fingerprint, s.feed); err != nil {
			return err
		}
	}
	if err := pruneProfiles(context.Background(), tx, now); err != nil {
		return err
	}
	if err := pruneAttachments(context.Background(), tx, now); err != nil {
		return err
	}
	if err := s.enforceStorage(context.Background(), tx, 0); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *chatStore) cleanPeriodically(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if err := s.expire(ctx, now); err != nil && ctx.Err() == nil {
				log.Printf("chat storage cleanup: %v", err)
			}
		}
	}
}

func (s *chatStore) expire(ctx context.Context, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := pruneProfiles(ctx, tx, now); err != nil {
		return err
	}
	if err := pruneAttachments(ctx, tx, now); err != nil {
		return err
	}
	if err := s.enforceStorage(ctx, tx, 0); err != nil {
		return err
	}
	return tx.Commit()
}

type chatClaims struct {
	Feed      string `json:"feed"`
	Name      string `json:"name"`
	ProfileID string `json:"profileId,omitempty"`
	Expires   int64  `json:"expires"`
}

func (a *app) signChat(payload string) []byte {
	mac := hmac.New(sha256.New, []byte(a.cfg.APISecret))
	mac.Write([]byte("pawtalk-chat-v1:" + a.cfg.PasswordHash + ":" + payload))
	return mac.Sum(nil)
}

func (a *app) chatToken(name, profileID string) string {
	claims, _ := json.Marshal(chatClaims{Feed: a.chat.feed, Name: name, ProfileID: profileID, Expires: a.now().Add(12 * time.Hour).Unix()})
	payload := b64.EncodeToString(claims)
	return payload + "." + b64.EncodeToString(a.signChat(payload))
}

func (a *app) authorizeChat(w http.ResponseWriter, r *http.Request) (chatClaims, bool) {
	var claims chatClaims
	token, bearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	payload, signature, found := strings.Cut(token, ".")
	mac, err := b64.DecodeString(signature)
	if bearer && found && len(token) <= 1024 && err == nil && hmac.Equal(mac, a.signChat(payload)) {
		raw, err := b64.DecodeString(payload)
		if err == nil && json.Unmarshal(raw, &claims) == nil && claims.Feed == a.chat.feed && claims.Expires > a.now().Unix() {
			return claims, true
		}
	}
	fail(w, http.StatusUnauthorized, "Chat authorization expired")
	return chatClaims{}, false
}

type chatPacket struct {
	RequestID    string `json:"requestId"`
	Nonce        []byte `json:"nonce"`
	Ciphertext   []byte `json:"ciphertext"`
	AttachmentID string `json:"attachmentId,omitempty"`
}

type chatRecord struct {
	chatPacket
	ID       int64  `json:"id"`
	Author   string `json:"author"`
	AuthorID string `json:"authorId,omitempty"`
	Sent     int64  `json:"sent"`
}

func (a *app) chatHistory(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Has("limit") {
		a.chatPage(w, r)
		return
	}
	if _, ok := a.authorizeChat(w, r); !ok {
		return
	}
	after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if err != nil || after < 0 {
		fail(w, 400, "Invalid chat cursor")
		return
	}
	ctx := r.Context()
	tx, err := a.chat.db.BeginTx(ctx, nil)
	if err != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	defer tx.Rollback()
	var first int64
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MIN(id), 0) FROM chat_messages WHERE feed = ?", a.chat.feed).Scan(&first); err != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT id, request_id, author, author_id, sent, nonce, ciphertext, attachment_id FROM chat_messages
		WHERE feed = ? AND id > ? ORDER BY id LIMIT 500
	`, a.chat.feed, after)
	if err != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	defer rows.Close()
	messages := []chatRecord{}
	for rows.Next() {
		var msg chatRecord
		if err := rows.Scan(&msg.ID, &msg.RequestID, &msg.Author, &msg.AuthorID, &msg.Sent, &msg.Nonce, &msg.Ciphertext, &msg.AttachmentID); err != nil {
			fail(w, 503, "Chat history unavailable")
			return
		}
		if msg.Nonce == nil {
			msg.Nonce = []byte{}
		}
		messages = append(messages, msg)
	}
	if rows.Err() != nil {
		fail(w, 503, "Chat history unavailable")
		return
	}
	result := map[string]any{"first": first, "messages": messages}
	if raw := r.URL.Query().Get("profilesAfter"); raw != "" {
		revision, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || revision < 0 {
			fail(w, 400, "Invalid profile cursor")
			return
		}
		profiles, err := readProfiles(ctx, tx, a.chat.feed, revision)
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

var errChatConflict = errors.New("chat request ID reused")
var errChatRate = errors.New("chat message rate exceeded")

func (s *chatStore) post(ctx context.Context, packet chatPacket, author, profileID string, now time.Time) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var id int64
	var nonce, ciphertext []byte
	var previousAuthor, previousAttachment string
	err = tx.QueryRowContext(ctx, "SELECT id, nonce, ciphertext, author_id, attachment_id FROM chat_messages WHERE feed = ? AND request_id = ?", s.feed, packet.RequestID).Scan(&id, &nonce, &ciphertext, &previousAuthor, &previousAttachment)
	if err == nil {
		if previousAuthor != profileID || previousAttachment != packet.AttachmentID || !bytes.Equal(nonce, packet.Nonce) || !bytes.Equal(ciphertext, packet.Ciphertext) {
			return 0, errChatConflict
		}
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var recent int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM chat_messages WHERE feed = ? AND sent > ? AND author_id = ?
		AND (author_id <> '' OR author = ?)`, s.feed, now.Add(-time.Second).UnixMilli(), profileID, author).Scan(&recent); err != nil {
		return 0, err
	}
	if recent >= 3 {
		return 0, errChatRate
	}
	if packet.AttachmentID != "" {
		var owner string
		if err := tx.QueryRowContext(ctx, "SELECT owner FROM chat_attachments WHERE feed = ? AND id = ?", s.feed, packet.AttachmentID).Scan(&owner); err != nil || owner != attachmentOwner(profileID, author) {
			return 0, errChatAttachment
		}
	}
	if profileID != "" {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO chat_profiles(feed, profile_id, nickname, updated) VALUES (?, ?, ?, ?)`,
			s.feed, profileID, author, now.UnixMilli()); err != nil {
			return 0, err
		}
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO chat_messages(feed, request_id, author, author_id, sent, nonce, ciphertext, attachment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		s.feed, packet.RequestID, author, profileID, now.UnixMilli(), packet.Nonce, packet.Ciphertext, packet.AttachmentID)
	if err != nil {
		return 0, err
	}
	id, err = result.LastInsertId()
	if err != nil {
		return 0, err
	}
	// Embedded rooms remain bounded in memory; VPS history is bounded by bytes.
	if s.ephemeral {
		if _, err := tx.ExecContext(ctx, `DELETE FROM chat_messages WHERE id <= (
		 SELECT id FROM chat_messages ORDER BY id DESC LIMIT 1 OFFSET 500)`); err != nil {
			return 0, err
		}
	}
	if err := pruneProfiles(ctx, tx, now); err != nil {
		return 0, err
	}
	if err := pruneAttachments(ctx, tx, now); err != nil {
		return 0, err
	}
	if err := s.enforceStorage(ctx, tx, id); err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

func (a *app) chatPost(w http.ResponseWriter, r *http.Request) {
	claims, ok := a.authorizeChat(w, r)
	if !ok {
		return
	}
	var packet chatPacket
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 18000))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&packet) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		fail(w, 400, "Invalid chat packet")
		return
	}
	id, err := hex.DecodeString(packet.RequestID)
	validPayload := len(packet.Ciphertext) > 0 && len(packet.Ciphertext) <= 12304 && ((!a.cfg.RequireE2EE && len(packet.Nonce) == 0) || (len(packet.Nonce) == 12 && len(packet.Ciphertext) > 16))
	if err != nil || len(id) != 16 || hex.EncodeToString(id) != packet.RequestID || !validPayload || (packet.AttachmentID != "" && !validAttachmentID(packet.AttachmentID)) {
		fail(w, 400, "Invalid chat packet")
		return
	}
	number, err := a.chat.post(r.Context(), packet, claims.Name, claims.ProfileID, a.now())
	if errors.Is(err, errChatConflict) {
		fail(w, 409, "Chat request ID reused")
	} else if errors.Is(err, errChatAttachment) {
		fail(w, 400, "Chat attachment unavailable")
	} else if errors.Is(err, errChatRate) {
		w.Header().Set("Retry-After", "1")
		fail(w, 429, "Chat message rate exceeded")
	} else if errors.Is(err, errChatStorage) {
		fail(w, 507, "Chat storage full")
	} else if err != nil {
		fail(w, 503, "Chat storage unavailable")
	} else {
		respond(w, 200, map[string]int64{"id": number})
	}
}
