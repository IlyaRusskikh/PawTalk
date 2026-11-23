package main

import (
	"database/sql"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
)

// Host-only status has no credentials. Read-only mode never initializes a data
// directory merely because Manager requested a snapshot.
func inspectMembershipHost(path string) (map[string]any, error) {
	db, err := openMembershipReadOnly(path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return nil, err
	}
	if version != membershipSchemaVersion {
		return nil, errors.New("unsupported server data schema")
	}
	var server string
	var initialized bool
	if err = db.QueryRow("SELECT server_id,e2ee_key_id IS NOT NULL FROM server_state WHERE id=1").Scan(&server, &initialized); err != nil {
		return nil, err
	}
	return map[string]any{"apiProtocolVersion": 2, "dataSchema": 2, "serverId": server, "initialized": initialized}, nil
}

func openMembershipReadOnly(path string) (*sql.DB, error) {
	return openExistingMembershipDatabase(path, url.Values{"mode": {"ro"}, "_pragma": {"busy_timeout(5000)"}})
}

func openExistingMembershipDatabase(path string, query url.Values) (*sql.DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	source := (&url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(absolute), "/"), RawQuery: query.Encode()}).String()
	db, err := sql.Open("sqlite", source)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}
