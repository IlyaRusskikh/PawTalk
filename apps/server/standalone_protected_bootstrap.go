package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"pawtalk/server/internal/access"
)

const protectedStandaloneSchemaVersion = 5

func isProtectedStandaloneDatabase(path string) (bool, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	db, err := openMembershipReadOnly(path)
	if err != nil {
		return false, err
	}
	defer db.Close()
	var version int
	err = db.QueryRow("PRAGMA user_version").Scan(&version)
	return version == protectedStandaloneSchemaVersion, err
}

func initializeProtectedStandalone(path string) error {
	store, err := openMembershipStore(path)
	if err != nil {
		return err
	}
	defer store.db.Close()
	tx, err := store.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`CREATE TABLE protected_standalone_bootstrap (
		id INTEGER PRIMARY KEY CHECK(id=1),
		token_hash TEXT NOT NULL DEFAULT '',
		expires_at INTEGER NOT NULL DEFAULT 0,
		receipt BLOB
	) STRICT;
	INSERT INTO protected_standalone_bootstrap(id) VALUES(1);
	PRAGMA user_version=5;`); err != nil {
		return err
	}
	return tx.Commit()
}

func issueProtectedStandaloneInvitation(ctx context.Context, path, address string) (string, error) {
	db, err := openMigrationImportDatabase(path)
	if err != nil {
		return "", err
	}
	defer db.Close()
	token, err := randomHex(32)
	if err != nil {
		return "", err
	}
	var serverID string
	if err := db.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return "", err
	}
	result, err := db.ExecContext(ctx, `UPDATE protected_standalone_bootstrap SET token_hash=?,expires_at=?
		WHERE id=1 AND receipt IS NULL`, publicKeyID([]byte(token)), time.Now().Add(24*time.Hour).UnixMilli())
	if err != nil {
		return "", err
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return "", errors.New("server owner is already initialized")
	}
	fields := url.Values{"v": {"3"}, "setup": {"1"}, "server": {serverID}, "token": {token}}
	return address + "#" + fields.Encode(), nil
}

func readProtectedStandaloneStatus(ctx context.Context, db *sql.DB) (string, *protectedSelfhostReady, error) {
	var serverID string
	var raw []byte
	err := db.QueryRowContext(ctx, `SELECT s.server_id,b.receipt FROM server_state s
		CROSS JOIN protected_standalone_bootstrap b WHERE s.id=1 AND b.id=1`).Scan(&serverID, &raw)
	if err != nil || raw == nil {
		return serverID, nil, err
	}
	var ready protectedSelfhostReady
	var anchor string
	var proofRecord []byte
	if err := json.Unmarshal(raw, &ready); err != nil || ready.ServerID != serverID ||
		!validHexID(ready.Binding, 64) || !validHexID(ready.CutoverDigest, 64) || !validHexID(ready.OwnerDeviceID, 64) ||
		!validHexID(ready.OwnerProfileID, 64) || !validHexID(ready.AnchorDigest, 64) {
		return "", nil, errors.New("invalid standalone protected bootstrap receipt")
	}
	if err := db.QueryRowContext(ctx, "SELECT digest,record FROM protected_policy_proofs WHERE revision=1").Scan(&anchor, &proofRecord); err != nil || anchor != ready.AnchorDigest {
		return "", nil, errors.New("standalone protected bootstrap receipt does not match the policy anchor")
	}
	var proof access.PolicyProof
	if err := json.Unmarshal(proofRecord, &proof); err != nil ||
		proof.Draft.Action != access.AnchorPolicy || proof.Principal.ProfileID != ready.OwnerProfileID ||
		proof.Principal.DeviceID != ready.OwnerDeviceID || publicKeyID(proof.Draft.Signature) != ready.AnchorDigest ||
		verifyProtectedPolicyDraftSignature(ctx, db, proof.Principal, proof.Draft) != nil {
		return "", nil, errors.New("standalone protected bootstrap policy anchor is invalid")
	}
	return serverID, &ready, nil
}

func serveFreshProtectedStandalone(ctx context.Context, path string, state serverState, certificate tls.Certificate, fingerprint string, maxBytes int64) error {
	db, err := openMigrationImportDatabase(path)
	if err != nil {
		return err
	}
	defer db.Close()
	store := &membershipStore{db: db, now: time.Now, maxBytes: maxBytes}
	_, ready, err := readProtectedStandaloneStatus(ctx, db)
	if err != nil {
		return err
	}
	if ready == nil {
		bootstrap, stop := context.WithCancel(ctx)
		defer stop()
		server := standaloneHTTPServer(protectedStandaloneBootstrapHandler(store, fingerprint, stop), certificate)
		if err := serveStandaloneTLS(bootstrap, server, "PawTalk API 3 awaiting owner setup.", nil); err != nil || ctx.Err() != nil {
			return err
		}
		_, ready, err = readProtectedStandaloneStatus(ctx, db)
		if err != nil {
			return err
		}
		if ready == nil {
			return errors.New("standalone protected bootstrap ended without an owner")
		}
	}
	store.protectedBinding = ready.Binding
	runtime := &protectedRuntime{store: store, serverID: ready.ServerID, cutoverDigest: ready.CutoverDigest,
		anchorDigest: ready.AnchorDigest, challenges: make(map[string]int64)}
	return serveStandaloneRuntime(ctx, runtime, state, certificate)
}

func protectedStandaloneBootstrapHandler(store *membershipStore, fingerprint string, activated func()) http.Handler {
	var lock sync.Mutex
	var pending *protectedSelfhostBootstrap
	var pendingToken string
	limiter := &membershipAPI{store: store, attempts: make(map[string]attempt)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		respond(w, http.StatusOK, map[string]any{"status": "awaiting_owner", "apiProtocolVersion": 3})
	})
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, _ *http.Request) {
		memberFail(w, memberError(http.StatusServiceUnavailable, "PROTECTED_BOOTSTRAP_REQUIRED"))
	})
	mux.HandleFunc("POST /api/v3/bootstrap/offer", limiter.limited(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Token string                 `json:"token"`
			Owner protectedSelfhostOwner `json:"owner"`
		}
		if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
			memberFail(w, err)
			return
		}
		token := publicKeyID([]byte(input.Token))
		var authorized bool
		if !validHexID(input.Token, 64) ||
			store.db.QueryRowContext(r.Context(), `SELECT receipt IS NULL AND token_hash=? AND expires_at>?
			FROM protected_standalone_bootstrap WHERE id=1`, token, time.Now().UnixMilli()).Scan(&authorized) != nil || !authorized {
			memberFail(w, memberError(http.StatusForbidden, "INVALID_INVITE"))
			return
		}
		offer, err := prepareProtectedSelfhost(r.Context(), store, fingerprint, input.Owner)
		if err != nil {
			memberFail(w, memberError(http.StatusBadRequest, "INVALID_PROTECTED_SELFHOST"))
			return
		}
		lock.Lock()
		pending, pendingToken = &offer, token
		lock.Unlock()
		respond(w, http.StatusOK, map[string]any{"fingerprint": fingerprint, "protected": offer.offer})
	}))
	mux.HandleFunc("POST /api/v3/bootstrap/approve", limiter.limited(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Token    string                    `json:"token"`
			Binding  string                    `json:"binding"`
			Approval protectedSelfhostApproval `json:"approval"`
		}
		if _, err := decodeMemberJSON(w, r, 2048, &input); err != nil {
			memberFail(w, err)
			return
		}
		lock.Lock()
		defer lock.Unlock()
		invalid := memberError(http.StatusForbidden, "INVALID_INVITE")
		if !validHexID(input.Token, 64) || pending == nil || pending.offer.Binding != input.Binding || publicKeyID([]byte(input.Token)) != pendingToken {
			memberFail(w, invalid)
			return
		}
		_, ready, err := pending.activateWithReceipt(r.Context(), store, input.Approval, func(tx *sql.Tx, ready protectedSelfhostReady) error {
			raw, err := json.Marshal(ready)
			if err != nil {
				return err
			}
			result, err := tx.ExecContext(r.Context(), `UPDATE protected_standalone_bootstrap
				SET token_hash='',expires_at=0,receipt=? WHERE id=1 AND receipt IS NULL AND token_hash=? AND expires_at>?`,
				raw, pendingToken, time.Now().UnixMilli())
			if err != nil {
				return err
			}
			count, err := result.RowsAffected()
			if err != nil || count != 1 {
				return invalid
			}
			return nil
		})
		if err != nil {
			if errors.Is(err, errInvalidProtectedSelfhostApproval) {
				err = invalid
			}
			memberFail(w, err)
			return
		}
		pending, pendingToken = nil, ""
		respond(w, http.StatusOK, map[string]any{"fingerprint": fingerprint, "protected": ready})
		activated()
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.TLS == nil {
			memberFail(w, memberError(http.StatusUpgradeRequired, "TLS_REQUIRED"))
			return
		}
		mux.ServeHTTP(w, r)
	})
}
