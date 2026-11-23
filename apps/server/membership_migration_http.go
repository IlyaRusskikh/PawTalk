package main

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"sync"
)

type migrationAuthority struct {
	serverID, ownerID, archiveSHA256, hostIdentitySHA256 string
}

type migrationHistoryChallenge struct {
	Nonce     string `json:"nonce"`
	ServerID  string `json:"serverId"`
	ExpiresAt int64  `json:"expiresAt"`
}

type migrationHistoryProof struct {
	Nonce         string `json:"nonce"`
	DeviceID      string `json:"deviceId"`
	ArchiveSHA256 string `json:"archiveSha256"`
	Cursor        string `json:"cursor"`
	Limit         int    `json:"limit"`
	Signature     string `json:"signature"`
}

type migrationHistoryResponse struct {
	ServerID      string `json:"serverId"`
	ArchiveSHA256 string `json:"archiveSha256"`
	migrationHistoryPage
	Progress        *migrationImportProgress             `json:"progress,omitempty"`
	Policy          *migrationPolicyDraft                `json:"policy,omitempty"`
	RecoveryArchive *migrationPendingRecoveryArchivePage `json:"recoveryArchive,omitempty"`
}

type pendingMigrationChallenge struct {
	authority migrationAuthority
	expiresAt int64
	recovery  *ecdh.PrivateKey
}

type protectedMigrationAPI struct {
	store      *membershipStore
	importer   *membershipStore
	mu         sync.Mutex
	challenges map[string]pendingMigrationChallenge
	importSlot chan struct{}
}

const migrationHealthPath = "/api/v3/migration/healthz"
const migrationCheckpointHeader = "X-PawTalk-Migration-Checkpoint"

func newProtectedMigrationHandler(store, importer *membershipStore) http.Handler {
	return newProtectedMigrationHandlerWithControl(store, importer, "")
}

func newProtectedMigrationHandlerWithControl(store, importer *membershipStore, dir string) http.Handler {
	a := &protectedMigrationAPI{store: store, importer: importer, challenges: make(map[string]pendingMigrationChallenge), importSlot: make(chan struct{}, 1)}
	limiter := &membershipAPI{store: store, attempts: make(map[string]attempt)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v3/migration/challenge", limiter.limited(a.issueChallenge))
	mux.HandleFunc("POST /api/v3/migration/history/{kind}/page", limiter.limited(a.history))
	operations := []string{"progress", "policy"}
	if dir != "" {
		operations = append(operations, "checkpoint")
	}
	for _, operation := range operations {
		mux.HandleFunc("POST /api/v3/migration/"+operation, limiter.limited(func(w http.ResponseWriter, r *http.Request) {
			r.SetPathValue("kind", operation)
			a.history(w, r)
		}))
	}
	mux.HandleFunc("POST /api/v3/migration/recovery/archive/pending", limiter.limited(func(w http.ResponseWriter, r *http.Request) {
		r.SetPathValue("kind", "recovery-archive")
		a.history(w, r)
	}))
	if importer != nil {
		mux.HandleFunc("POST /api/v3/migration/history/{kind}/import", limiter.limited(a.importHistory))
		mux.HandleFunc("GET /api/v3/migration/recovery/challenge", limiter.limited(a.issueRecoveryChallenge))
		mux.HandleFunc("POST /api/v3/migration/recovery", limiter.limited(a.enrollOwnerRecovery))
		mux.HandleFunc("POST /api/v3/migration/recovery/archive", limiter.limited(a.stageOwnerRecoveryArchive))
		mux.HandleFunc("POST /api/v3/migration/recipient", limiter.limited(a.enrollMigrationOwnerRecipient))
		mux.HandleFunc("POST /api/v3/migration/keys/{action}", limiter.limited(a.migrationKeys))
		if dir != "" {
			for _, action := range []string{"report", "approve-import", "stage-policy", "approve-cutover"} {
				mux.HandleFunc("POST /api/v3/migration/control/"+action, limiter.limited(func(w http.ResponseWriter, r *http.Request) {
					a.migrationControl(dir, action, w, r)
				}))
			}
		}
	}
	mux.HandleFunc("GET "+migrationHealthPath, func(w http.ResponseWriter, r *http.Request) {
		authority, err := currentMigrationAuthority(r.Context(), store.db)
		if err != nil {
			memberFail(w, err)
			return
		}
		if expected := r.Header.Get(migrationCheckpointHeader); expected != "" && expected != authority.archiveSHA256 {
			memberFail(w, memberError(http.StatusConflict, "MIGRATION_CHECKPOINT_CHANGED"))
			return
		}
		respond(w, http.StatusOK, map[string]string{"status": "maintenance"})
	})
	maintenance := func(w http.ResponseWriter, _ *http.Request) {
		memberFail(w, memberError(http.StatusServiceUnavailable, "MIGRATION_MAINTENANCE"))
	}
	mux.HandleFunc("GET /healthz", maintenance)
	mux.HandleFunc("GET /api/config", maintenance)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.TLS == nil {
			memberFail(w, memberError(http.StatusUpgradeRequired, "TLS_REQUIRED"))
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func readMigrationAuthority(ctx context.Context, tx membershipIdentityQuery) (migrationAuthority, error) {
	var authority migrationAuthority
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return authority, err
	}
	if version != membershipMigrationSchemaVersion {
		return authority, memberError(http.StatusServiceUnavailable, "MIGRATION_UNAVAILABLE")
	}
	return readFrozenMigrationAuthority(ctx, tx)
}

func readFrozenMigrationAuthority(ctx context.Context, tx membershipIdentityQuery) (migrationAuthority, error) {
	var authority migrationAuthority
	var checkpoint bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='protected_migration_source')`).Scan(&checkpoint); err != nil {
		return authority, err
	}
	if !checkpoint {
		return authority, memberError(http.StatusServiceUnavailable, "MIGRATION_UNAVAILABLE")
	}
	var declared int
	err := tx.QueryRowContext(ctx, `SELECT s.server_id,s.schema_version,m.owner_profile_id,m.backup_archive_sha256,m.host_identity_sha256
		FROM server_state s CROSS JOIN protected_migration_source m WHERE s.id=1 AND m.id=1`).
		Scan(&authority.serverID, &declared, &authority.ownerID, &authority.archiveSHA256, &authority.hostIdentitySHA256)
	if err == nil && declared != membershipSchemaVersion {
		return authority, memberError(http.StatusServiceUnavailable, "MIGRATION_UNAVAILABLE")
	}
	if err == nil && (!validHexID(authority.serverID, 32) || !validHexID(authority.ownerID, 64) ||
		!validHexID(authority.archiveSHA256, 64) || !validHexID(authority.hostIdentitySHA256, 64)) {
		err = errors.New("invalid protected migration checkpoint")
	}
	return authority, err
}

func currentMigrationAuthority(ctx context.Context, db *sql.DB) (migrationAuthority, error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return migrationAuthority{}, err
	}
	defer tx.Rollback()
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		return authority, err
	}
	return authority, tx.Commit()
}

func (a *protectedMigrationAPI) issueChallenge(w http.ResponseWriter, r *http.Request) {
	a.issueMigrationChallenge(w, r, nil)
}

func (a *protectedMigrationAPI) issueMigrationChallenge(w http.ResponseWriter, r *http.Request, recovery *ecdh.PrivateKey) {
	authority, err := currentMigrationAuthority(r.Context(), a.store.db)
	if err != nil {
		memberFail(w, err)
		return
	}
	nonce, err := randomHex(32)
	if err != nil {
		memberFail(w, err)
		return
	}
	now := a.store.now().UnixMilli()
	expiresAt := now + membershipChallengeSeconds*1000
	a.mu.Lock()
	for key, entry := range a.challenges {
		if entry.expiresAt <= now {
			delete(a.challenges, key)
		}
	}
	if len(a.challenges) >= 1024 {
		a.mu.Unlock()
		memberFail(w, memberError(http.StatusTooManyRequests, "CHALLENGE_LIMIT"))
		return
	}
	a.challenges[nonce] = pendingMigrationChallenge{authority, expiresAt, recovery}
	a.mu.Unlock()
	challenge := migrationHistoryChallenge{nonce, authority.serverID, expiresAt}
	if recovery == nil {
		respond(w, http.StatusOK, challenge)
		return
	}
	respond(w, http.StatusOK, migrationRecoveryChallenge{challenge, publicMigrationAgreementKey(recovery)})
}

func migrationHistoryProofFrame(serverID, kind string, proof migrationHistoryProof) ([]byte, error) {
	return signatureFrame("pawtalk-migration-history-v1", serverID, proof.DeviceID, proof.Nonce,
		proof.ArchiveSHA256, kind, proof.Cursor, strconv.Itoa(proof.Limit))
}

func (a *protectedMigrationAPI) history(w http.ResponseWriter, r *http.Request) {
	var proof migrationHistoryProof
	if _, err := decodeMemberJSON(w, r, 2048, &proof); err != nil {
		memberFail(w, err)
		return
	}
	response, err := a.loadHistory(r.Context(), r.PathValue("kind"), proof)
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, http.StatusOK, response)
}

func (a *protectedMigrationAPI) loadHistory(ctx context.Context, kind string, proof migrationHistoryProof) (migrationHistoryResponse, error) {
	var result migrationHistoryResponse
	if !validHexID(proof.Nonce, 64) || !validHexID(proof.DeviceID, 64) || (proof.ArchiveSHA256 != "" && !validHexID(proof.ArchiveSHA256, 64)) {
		return result, memberError(http.StatusBadRequest, "INVALID_MIGRATION_PROOF")
	}
	switch kind {
	case "checkpoint":
		if proof.Limit != 1 || proof.Cursor != "" || proof.ArchiveSHA256 != "" {
			return result, memberError(http.StatusBadRequest, "INVALID_MIGRATION_PAGE")
		}
	case "progress", "policy":
		if proof.Limit != 1 || proof.Cursor != "" || proof.ArchiveSHA256 == "" {
			return result, memberError(http.StatusBadRequest, "INVALID_MIGRATION_PAGE")
		}
	case "recovery-archive":
		if proof.ArchiveSHA256 == "" || proof.Limit < 1 || proof.Limit > 32 || (proof.Cursor != "" && !validHexID(proof.Cursor, 32)) {
			return result, memberError(http.StatusBadRequest, "INVALID_MIGRATION_PAGE")
		}
	default:
		relation, ok := migrationHistoryRelations[kind]
		if !ok || proof.Limit < 1 || proof.Limit > relation.limit || (proof.Cursor != "" && proof.ArchiveSHA256 == "") {
			return result, memberError(http.StatusBadRequest, "INVALID_MIGRATION_PAGE")
		}
		if _, err := migrationHistoryPosition(relation, proof.Cursor); err != nil {
			return result, memberError(http.StatusBadRequest, "INVALID_MIGRATION_PAGE")
		}
	}
	signature, err := decodeFixed(proof.Signature, ed25519.SignatureSize)
	if err != nil {
		return result, memberError(http.StatusUnauthorized, "INVALID_MIGRATION_PROOF")
	}
	tx, err := a.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	authority, err := a.authorizeChallenge(ctx, tx, proof.Nonce, proof.DeviceID, signature, func(serverID string) ([]byte, error) {
		return migrationHistoryProofFrame(serverID, kind, proof)
	})
	if err != nil {
		return result, err
	}
	if proof.ArchiveSHA256 != "" && proof.ArchiveSHA256 != authority.archiveSHA256 {
		return result, memberError(http.StatusConflict, "MIGRATION_CHECKPOINT_CHANGED")
	}
	result.ServerID, result.ArchiveSHA256 = authority.serverID, authority.archiveSHA256
	if kind == "checkpoint" {
		return result, tx.Commit()
	}
	if kind == "recovery-archive" {
		page, err := readMigrationPendingRecoveryArchive(ctx, tx, authority, proof.Cursor, proof.Limit)
		if err != nil {
			return result, err
		}
		result.RecoveryArchive = &page
		return result, tx.Commit()
	}
	if kind == "policy" {
		policy, err := readMigrationPolicyDraft(ctx, tx, authority)
		if err != nil {
			return result, err
		}
		result.Policy = &policy
		return result, tx.Commit()
	}
	if kind == "progress" {
		progress, err := readMigrationImportProgress(ctx, tx)
		if err != nil {
			return result, err
		}
		result.Progress = &progress
		return result, tx.Commit()
	}
	result.migrationHistoryPage, err = readProtectedMigrationHistory(ctx, tx, authority.archiveSHA256, kind, proof.Cursor, proof.Limit)
	if err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (a *protectedMigrationAPI) authorizeChallenge(ctx context.Context, tx membershipIdentityQuery, nonce, deviceID string, signature []byte,
	frameForServer func(string) ([]byte, error)) (migrationAuthority, error) {
	a.mu.Lock()
	challenge, issued := a.challenges[nonce]
	a.mu.Unlock()
	expired := memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
	if !issued || challenge.expiresAt <= a.store.now().UnixMilli() {
		return migrationAuthority{}, expired
	}
	authority, err := readMigrationAuthority(ctx, tx)
	if err != nil {
		return authority, err
	}
	if authority != challenge.authority {
		return authority, expired
	}
	frame, err := frameForServer(authority.serverID)
	if err != nil {
		return authority, err
	}
	if err := a.store.verifyMigrationDevice(ctx, tx, authority.ownerID, deviceID, frame, signature); err != nil {
		return authority, err
	}
	now := a.store.now().UnixMilli()
	a.mu.Lock()
	current, issued := a.challenges[nonce]
	delete(a.challenges, nonce)
	a.mu.Unlock()
	if !issued || current != challenge || challenge.expiresAt <= now {
		return authority, expired
	}
	return authority, nil
}

func (s *membershipStore) verifyMigrationDevice(ctx context.Context, tx membershipIdentityQuery, ownerID, deviceID string, frame, signature []byte) error {
	var originalProfileID string
	var publicKey []byte
	err := tx.QueryRowContext(ctx, "SELECT original_profile_id,signing_public_key FROM devices WHERE device_id=?", deviceID).
		Scan(&originalProfileID, &publicKey)
	if errors.Is(err, sql.ErrNoRows) {
		return memberError(http.StatusForbidden, "MIGRATION_DEVICE_DENIED")
	}
	if err != nil {
		return err
	}
	if len(publicKey) != ed25519.PublicKeySize || publicKeyID(publicKey) != deviceID || !ed25519.Verify(publicKey, frame, signature) {
		return memberError(http.StatusForbidden, "MIGRATION_DEVICE_DENIED")
	}
	identity, err := s.resolveIdentity(ctx, tx, memberIdentity{DeviceID: deviceID, ProfileID: originalProfileID})
	var denied *membershipError
	if errors.As(err, &denied) || (err == nil && identity.EffectiveProfileID != ownerID) {
		return memberError(http.StatusForbidden, "MIGRATION_DEVICE_DENIED")
	}
	return err
}
