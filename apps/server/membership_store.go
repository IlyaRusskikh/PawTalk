package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed membership.sql
var membershipSchema string

//go:embed membership_features.sql
var membershipFeaturesSchema string

const membershipSchemaVersion = 2

type membershipStore struct {
	events           chatEvents
	deliveries       messageDeliveries
	voiceNetwork     voiceNetworkCache
	db               *sql.DB
	now              func() time.Time
	maxBytes         int64
	protectedBinding string
}

func randomHex(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

// openMembershipStore never migrates, replaces or deletes a legacy database.
// Both hosting modes use this exact schema; selfhost supplies :memory:.
func openMembershipStore(path string) (*membershipStore, error) {
	return openMembershipDatabase(path, time.Now)
}

func openMembershipDatabase(path string, now func() time.Time) (*membershipStore, error) {
	if err := prepareMembershipPath(path); err != nil {
		return nil, err
	}
	query := url.Values{"_pragma": {"foreign_keys(1)", "busy_timeout(5000)"}, "_txlock": {"immediate"}}
	var source string
	if path == ":memory:" {
		id, err := randomHex(16)
		if err != nil {
			return nil, err
		}
		query.Set("mode", "memory")
		query.Set("cache", "private")
		source = "file:membership-" + id + "?" + query.Encode()
	} else {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		source = (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(absolute), "/"), RawQuery: query.Encode()}).String()
	}
	db, err := sql.Open("sqlite", source)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &membershipStore{db: db, now: now, maxBytes: defaultChatStorage}
	if err = s.initialize(); err != nil {
		db.Close()
		return nil, err
	}
	if err = s.expandAttachmentStorage(); err != nil {
		db.Close()
		return nil, err
	}
	if _, err = s.db.Exec(membershipFeaturesSchema); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *membershipStore) initialize() error {
	if _, err := s.db.Exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;"); err != nil {
		return err
	}
	var version, tables int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if err := s.db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil {
		return err
	}
	if tables > 0 {
		if version == membershipMigrationSchemaVersion || version == protectedDataSchemaVersion {
			return errors.New("database uses a protected schema or is under migration maintenance; API 2 startup refused")
		}
		if version != membershipSchemaVersion {
			return errors.New("unsupported server database schema; use a fresh API 2 data file")
		}
		var protected bool
		if err := s.db.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='protected_policy' COLLATE NOCASE)").Scan(&protected); err != nil {
			return err
		}
		if protected {
			return errors.New("database contains protected policy state; API 2 startup refused")
		}
		var declared int
		if err := s.db.QueryRow("SELECT schema_version FROM server_state WHERE id=1").Scan(&declared); err != nil || declared != version {
			return errors.New("invalid server database identity")
		}
		var seed, key []byte
		var id string
		if err := s.db.QueryRow("SELECT identity_seed,identity_public_key,server_id FROM server_state WHERE id=1").Scan(&seed, &key, &id); err != nil {
			return err
		}
		if len(seed) != 32 || !bytes.Equal(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey), key) || publicKeyID(key)[:32] != id {
			return errors.New("invalid server signing identity")
		}
		return nil
	}
	if version != 0 {
		return errors.New("unsupported empty database version")
	}
	if _, err := s.db.Exec("PRAGMA auto_vacuum=FULL"); err != nil {
		return err
	}
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return err
	}
	serverPublic := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	serverID := publicKeyID(serverPublic)[:32]
	textID, err := randomHex(16)
	if err != nil {
		return err
	}
	voiceID, err := randomHex(16)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(membershipSchema); err != nil {
		return fmt.Errorf("create membership schema: %w", err)
	}
	if _, err = tx.Exec("INSERT INTO server_state(id,schema_version,server_id,identity_seed,identity_public_key,name) VALUES(1,2,?,?,?,'PawTalk')", serverID, seed, []byte(serverPublic)); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO channels(channel_id,kind,name,position,protected_kind) VALUES(?,'text','Общий',0,'default_text'),(?,'voice','Основной',1,'default_voice')", textID, voiceID); err != nil {
		return err
	}
	return tx.Commit()
}

// A new persistent store is private to the host account before SQLite opens it.
func prepareMembershipPath(path string) error {
	if path == ":memory:" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return file.Close()
}

// Rebuild only the bounded attachment table, retaining bytes and ownership triggers.
func (s *membershipStore) expandAttachmentStorage() error {
	var ddl string
	if err := s.db.QueryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'").Scan(&ddl); err != nil {
		return err
	}
	if !strings.Contains(ddl, "2097168") {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	expanded := strings.Replace(ddl, "2097168", "52428816", 1)
	expanded = strings.Replace(expanded, "CREATE TABLE attachments", "CREATE TABLE attachments_expanded", 1)
	if _, err = tx.Exec(expanded); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO attachments_expanded SELECT * FROM attachments; DROP TABLE attachments; ALTER TABLE attachments_expanded RENAME TO attachments;"); err != nil {
		return err
	}
	start := strings.Index(membershipSchema, "CREATE INDEX pending_attachments")
	end := strings.Index(membershipSchema[start:], "CREATE TABLE invites") + start
	if _, err = tx.Exec(membershipSchema[start:end]); err != nil {
		return err
	}
	return tx.Commit()
}
