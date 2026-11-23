package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"errors"
	"net/http"
	"sync"

	"pawtalk/server/internal/access"
)

type protectedRuntime struct {
	store                *membershipStore
	serverID             string
	cutoverDigest        string
	anchorDigest         string
	importedChannelNames map[string]string
	importedRoleNames    map[string]string
	importedProfileNames map[string]string
	mu                   sync.Mutex
	challenges           map[string]int64
	textPolicyProofs     access.TextChannelPolicyProofCache
	events               chatEvents
	presence             protectedPresence
}

type protectedSessionChallenge struct {
	Protocol      int    `json:"apiProtocolVersion"`
	ServerID      string `json:"serverId"`
	CutoverDigest string `json:"cutoverDigest"`
	Binding       string `json:"binding"`
	Nonce         string `json:"nonce"`
	ExpiresAt     int64  `json:"expiresAt"`
}

type protectedSessionRequest struct {
	DeviceID  string `json:"deviceId"`
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"`
}

type protectedSessionReceipt struct {
	Token     string `json:"token"`
	SessionID string `json:"sessionId"`
	ProfileID string `json:"profileId"`
	DeviceID  string `json:"deviceId"`
	ExpiresAt int64  `json:"expiresAt"`
}

const protectedSessionSchema = `CREATE TABLE IF NOT EXISTS protected_runtime_sessions (
	session_id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL,
	token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash)=32),
	binding TEXT NOT NULL CHECK(length(binding)=64),
	expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS protected_runtime_session_expiry ON protected_runtime_sessions(expires_at);
CREATE INDEX IF NOT EXISTS protected_runtime_session_device ON protected_runtime_sessions(device_id,binding);` + access.NicknameSchema

func ensureProtectedSessionSchema(ctx context.Context, tx *sql.Tx) error {
	var legacyReference bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM pragma_foreign_key_list('protected_runtime_sessions') WHERE "table"='devices'
	)`).Scan(&legacyReference); err != nil {
		return err
	}
	if legacyReference {
		// A fresh runtime binding already invalidates every token in this table.
		if _, err := tx.ExecContext(ctx, "DROP TABLE protected_runtime_sessions"); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, protectedSessionSchema)
	return err
}

func openProtectedRuntime(ctx context.Context, store *membershipStore, dir, archive string) (*protectedRuntime, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	activation, err := verifyProtectedActivation(ctx, tx, dir)
	if err != nil {
		return nil, err
	}
	if activation.ArchiveSHA256 != archive {
		return nil, memberError(http.StatusConflict, "MIGRATION_CHECKPOINT_CHANGED")
	}
	channelNames, err := readImportedNames(ctx, tx, "SELECT channel_id,name FROM channels")
	if err != nil {
		return nil, err
	}
	roleNames, err := readImportedNames(ctx, tx, "SELECT role_id,name FROM roles")
	if err != nil {
		return nil, err
	}
	profileNames, err := readImportedNames(ctx, tx, "SELECT profile_id,nickname FROM effective_profiles")
	if err != nil {
		return nil, err
	}
	binding, err := randomHex(32)
	if err != nil {
		return nil, err
	}
	if err := ensureProtectedSessionSchema(ctx, tx); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, protectedVoiceKeySchema); err != nil {
		return nil, err
	}
	if err := access.EnsureAttachmentSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureMessageDeletionSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureMessagePinSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureMessageReplySchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureMentionSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureInviteSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureChecklistSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsurePollVotingSchema(ctx, tx); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS protected_imported_poll_results
		ON polls(result_message_id) WHERE result_message_id IS NOT NULL`); err != nil {
		return nil, err
	}
	if err := access.EnsureTimeoutSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureAuditSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureCommunityNameSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureCommunityAvatarSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureRevisionSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsurePolicyAttestationSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureOwnerTransferSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.EnsureChannelLayoutSchema(ctx, tx); err != nil {
		return nil, err
	}
	if err := access.QueueArchiveWrapUpgrades(ctx, tx, store.now().UnixMilli()); err != nil {
		return nil, err
	}
	if err := access.QueueRecoveryOpeningUpgrades(ctx, tx, store.now().UnixMilli()); err != nil {
		return nil, err
	}
	// This binding starts a fresh media process. Pending moves and slots
	// belong to the previous process and must not block its replacement.
	if _, err := tx.ExecContext(ctx, `DELETE FROM protected_voice_keys;
		DELETE FROM protected_voice_moves;
		DELETE FROM protected_voice_slots;
		DELETE FROM protected_mention_presence;`); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	runtimeStore := &membershipStore{db: store.db, now: store.now, maxBytes: store.maxBytes, protectedBinding: binding}
	return &protectedRuntime{store: runtimeStore, serverID: activation.ServerID, cutoverDigest: activation.CutoverDigest,
		anchorDigest: activation.AnchorDigest, importedChannelNames: channelNames, importedRoleNames: roleNames, importedProfileNames: profileNames,
		challenges: make(map[string]int64)}, nil
}

func readImportedNames(ctx context.Context, tx *sql.Tx, query string) (map[string]string, error) {
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := make(map[string]string)
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		names[id] = name
	}
	return names, rows.Err()
}

func (p *protectedRuntime) issueSessionChallenge() (protectedSessionChallenge, error) {
	nonce, err := randomHex(32)
	if err != nil {
		return protectedSessionChallenge{}, err
	}
	now := p.store.now().UnixMilli()
	expires := now + membershipChallengeSeconds*1000
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, deadline := range p.challenges {
		if deadline <= now {
			delete(p.challenges, id)
		}
	}
	if len(p.challenges) >= 1024 {
		return protectedSessionChallenge{}, memberError(http.StatusTooManyRequests, "CHALLENGE_LIMIT")
	}
	p.challenges[nonce] = expires
	return protectedSessionChallenge{3, p.serverID, p.cutoverDigest, p.store.protectedBinding, nonce, expires}, nil
}

func (p *protectedRuntime) openSession(ctx context.Context, input protectedSessionRequest) (protectedSessionReceipt, error) {
	var result protectedSessionReceipt
	invalid := memberError(http.StatusUnauthorized, "INVALID_PROTECTED_SESSION_PROOF")
	if !validHexID(input.DeviceID, 64) || !validHexID(input.Nonce, 64) {
		return result, invalid
	}
	signature, err := decodeFixed(input.Signature, ed25519.SignatureSize)
	if err != nil {
		return result, invalid
	}
	p.mu.Lock()
	deadline := p.challenges[input.Nonce]
	p.mu.Unlock()
	expired := memberError(http.StatusUnauthorized, "EXPIRED_CHALLENGE")
	if deadline <= p.store.now().UnixMilli() {
		return result, expired
	}
	tx, err := p.store.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	frame, err := signatureFrame("pawtalk-protected-session-v1", p.serverID, p.cutoverDigest, p.store.protectedBinding, input.Nonce, input.DeviceID)
	if err != nil {
		return result, err
	}
	serverID, key, err := protectedSigner(ctx, tx, input.DeviceID)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (serverID != p.serverID || !ed25519.Verify(key, frame, signature)) {
		return result, invalid
	}
	if err != nil {
		return result, err
	}
	actor, err := p.resolveDevice(ctx, tx, input.DeviceID)
	if err != nil {
		return result, err
	}
	p.mu.Lock()
	current := p.challenges[input.Nonce]
	delete(p.challenges, input.Nonce)
	p.mu.Unlock()
	now := p.store.now().UnixMilli()
	if current != deadline || current <= now {
		return result, expired
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_runtime_sessions WHERE expires_at<=?", now); err != nil {
		return result, err
	}
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM protected_runtime_sessions WHERE device_id=? AND binding=?", input.DeviceID, p.store.protectedBinding).
		Scan(&count); err != nil {
		return result, err
	}
	if count >= 16 {
		return result, memberError(http.StatusTooManyRequests, "PROTECTED_SESSION_LIMIT")
	}
	token, raw, err := randomToken()
	if err != nil {
		return result, err
	}
	defer clear(raw)
	sessionID, err := randomHex(16)
	if err != nil {
		return result, err
	}
	hash := sha256.Sum256(raw)
	expires := now + membershipSessionSeconds*1000
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_runtime_sessions(session_id,device_id,token_hash,binding,expires_at)
		VALUES(?,?,?,?,?)`, sessionID, input.DeviceID, hash[:], p.store.protectedBinding, expires); err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	return protectedSessionReceipt{token, sessionID, actor.ProfileID, actor.DeviceID, expires}, nil
}

func (p *protectedRuntime) resolveSession(token string) access.ResolveSession {
	return func(ctx context.Context, query access.SessionQuery) (access.Principal, error) {
		_, principal, err := p.store.runtimeIdentityForToken(ctx, query, token)
		return principal, err
	}
}

const runtimeSessionIdentityQuery = `SELECT s.session_id,s.device_id,COALESCE(a.profile_id,d.original_profile_id,
	json_extract(p.snapshot,'$.PolicyDevices."' || s.device_id || '".ProfileID')),a.device_id IS NULL AND d.device_id IS NOT NULL
	FROM protected_runtime_sessions s LEFT JOIN devices d ON d.device_id=s.device_id
	LEFT JOIN protected_invite_admissions a ON a.device_id=s.device_id
	LEFT JOIN protected_policy p ON p.id=1
	WHERE s.binding=? AND s.expires_at>?`

func (s *membershipStore) runtimeIdentityForToken(ctx context.Context, query access.SessionQuery, token string) (memberAccess, access.Principal, error) {
	raw, err := decodeFixed(token, 32)
	if err != nil {
		return memberAccess{}, access.Principal{}, memberError(http.StatusUnauthorized, "INVALID_PROTECTED_SESSION")
	}
	hash := sha256.Sum256(raw)
	clear(raw)
	row := query.QueryRowContext(ctx, runtimeSessionIdentityQuery+" AND s.token_hash=?",
		s.protectedBinding, s.now().UnixMilli(), hash[:])
	return s.readRuntimeSessionIdentity(ctx, query, row)
}

func (s *membershipStore) runtimeIdentityForSession(ctx context.Context, query access.SessionQuery, sessionID string) (access.Principal, error) {
	row := query.QueryRowContext(ctx, runtimeSessionIdentityQuery+" AND s.session_id=?",
		s.protectedBinding, s.now().UnixMilli(), sessionID)
	_, principal, err := s.readRuntimeSessionIdentity(ctx, query, row)
	return principal, err
}

func (s *membershipStore) readRuntimeSessionIdentity(ctx context.Context, query access.SessionQuery, row *sql.Row) (memberAccess, access.Principal, error) {
	var id memberIdentity
	var sessionID string
	var profileID sql.NullString
	var imported bool
	if err := row.Scan(&sessionID, &id.DeviceID, &profileID, &imported); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = memberError(http.StatusUnauthorized, "INVALID_PROTECTED_SESSION")
		}
		return memberAccess{}, access.Principal{}, err
	}
	if !profileID.Valid {
		return memberAccess{}, access.Principal{}, memberError(http.StatusUnauthorized, "INVALID_PROTECTED_SESSION")
	}
	id.ProfileID = profileID.String
	member, err := s.resolveRuntimeMember(ctx, query, id, imported)
	if err != nil {
		return memberAccess{}, access.Principal{}, err
	}
	member.SessionID = sessionID
	principal, err := verifiedProtectedPrincipal(ctx, query, member, true)
	if errors.Is(err, access.Inactive) {
		if departure := protectedDeviceDeparture(ctx, query, id.DeviceID); departure != nil {
			return memberAccess{}, access.Principal{}, departure
		}
	}
	return member, principal, err
}

func (p *protectedRuntime) resolveDevice(ctx context.Context, query access.SessionQuery, device string) (access.Principal, error) {
	id := memberIdentity{DeviceID: device}
	imported := false
	err := query.QueryRowContext(ctx, "SELECT profile_id FROM protected_invite_admissions WHERE device_id=?", device).Scan(&id.ProfileID)
	if errors.Is(err, sql.ErrNoRows) {
		imported = true
		err = query.QueryRowContext(ctx, "SELECT original_profile_id FROM devices WHERE device_id=?", device).Scan(&id.ProfileID)
	}
	if errors.Is(err, sql.ErrNoRows) {
		imported = false
		err = query.QueryRowContext(ctx, `SELECT json_extract(snapshot,'$.PolicyDevices."' || ? || '".ProfileID')
			FROM protected_policy WHERE id=1 AND json_type(snapshot,'$.PolicyDevices."' || ? || '".ProfileID')='text'`, device, device).
			Scan(&id.ProfileID)
	}
	if err != nil {
		return access.Principal{}, err
	}
	identity, err := p.store.resolveRuntimeMember(ctx, query, id, imported)
	if err != nil {
		return access.Principal{}, err
	}
	actor, err := verifiedProtectedPrincipal(ctx, query, identity, true)
	if errors.Is(err, access.Inactive) {
		removal, readErr := access.ReadMemberRemoval(ctx, query, identity.EffectiveProfileID)
		if readErr != nil {
			return access.Principal{}, readErr
		}
		if removal.Action != "" {
			head, proofErr := access.ReadPolicyHead(ctx, query, nil)
			if proofErr != nil {
				return access.Principal{}, proofErr
			}
			if proofErr := verifyProtectedPolicyDraft(ctx, query, head.Principal, head.Draft); proofErr != nil {
				return access.Principal{}, proofErr
			}
			return access.Principal{}, protectedRemovalError(removal, removal.BannedAt(p.store.now().UnixMilli()))
		}
		if departure := protectedDeviceDeparture(ctx, query, device); departure != nil {
			return access.Principal{}, departure
		}
	}
	if !imported && errors.Is(err, access.Inactive) {
		return access.Principal{}, memberError(http.StatusUnauthorized, "INVALID_PROTECTED_SESSION_PROOF")
	}
	return actor, err
}

func protectedDeviceDeparture(ctx context.Context, query access.SessionQuery, deviceID string) error {
	head, detached, err := access.ReadDeviceDeparture(ctx, query, deviceID)
	if err != nil || head.Digest == "" {
		return err
	}
	if err := verifyProtectedPolicyDraft(ctx, query, head.Principal, head.Draft); err != nil {
		return err
	}
	if detached {
		return memberError(http.StatusForbidden, "PROTECTED_PROFILE_UNLINKED")
	}
	return memberError(http.StatusForbidden, "PROTECTED_DEVICE_REVOKED")
}

func protectedRemovalError(removal access.MemberRemoval, banned bool) *membershipError {
	details := map[string]any{"reason": removal.Reason, "moderationScope": "server", "moderationAction": removal.Action}
	if banned {
		var expiry any
		if removal.ExpiresAt != 0 {
			expiry = removal.ExpiresAt
		}
		details["expiresAt"] = expiry
		return &membershipError{Code: "BANNED", Status: http.StatusForbidden, Details: details}
	}
	details["membershipState"] = "kicked"
	return &membershipError{Code: "NOT_A_MEMBER", Status: http.StatusForbidden, Details: details}
}

func (s *membershipStore) resolveRuntimeMember(ctx context.Context, query access.SessionQuery, id memberIdentity, imported bool) (memberAccess, error) {
	member := memberAccess{memberIdentity: id, EffectiveProfileID: id.ProfileID, Permissions: []string{}}
	var signedMigrationBindings bool
	if imported {
		if err := query.QueryRowContext(ctx, `SELECT COALESCE(json_extract(snapshot,'$.ImportedProfileBindings'),0)
			FROM protected_policy WHERE id=1`).Scan(&signedMigrationBindings); err != nil {
			return memberAccess{}, err
		}
	}
	if imported && !signedMigrationBindings {
		legacy, err := s.resolveProtectedImportedMember(ctx, query, id)
		if err != nil {
			return member, err
		}
		member = legacy
	} else {
		if _, err := s.protectedInviteBoundProfile(ctx, query, id.ProfileID); err != nil {
			return memberAccess{}, err
		}
		if imported {
			// The frozen membership still distinguishes a formerly banned or
			// departed identity that has never opened a protected session.
			// Its effective profile instead comes from the signed bindings below.
			if _, err := s.resolveLegacyIdentity(ctx, query, id, true); err != nil {
				return memberAccess{}, err
			}
		}
	}
	// Keep the original identity for receipts and historical signatures. The
	// caller verifies the resulting principal against the signed policy head.
	var linkedProfile string
	err := query.QueryRowContext(ctx, `SELECT json_extract(snapshot,'$.ProfileBindings."' || ? || '"')
		FROM protected_policy WHERE id=1
		AND json_extract(snapshot,'$.ProfileDeviceOrigins."' || ? || '"')=?
		AND json_type(snapshot,'$.ProfileBindings."' || ? || '"')='text'`,
		member.EffectiveProfileID, id.DeviceID, member.EffectiveProfileID, member.EffectiveProfileID).Scan(&linkedProfile)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return memberAccess{}, err
	}
	if linkedProfile != "" {
		if _, err := s.protectedInviteBoundProfile(ctx, query, linkedProfile); err != nil {
			return memberAccess{}, err
		}
		member.EffectiveProfileID = linkedProfile
	}
	return member, nil
}

func (s *membershipStore) resolveProtectedImportedMember(ctx context.Context, query access.SessionQuery, id memberIdentity) (memberAccess, error) {
	member, err := s.resolveIdentity(ctx, query, id)
	var denied *membershipError
	if !errors.As(err, &denied) || denied.Code != "BANNED" {
		return member, err
	}
	if _, err := s.protectedInviteBoundProfile(ctx, query, id.ProfileID); err != nil {
		return member, err
	}
	return s.resolveLegacyIdentity(ctx, query, id, true)
}
