package access

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"strings"
)

const invitePageSize = 32
const maxInviteDate = 8_640_000_000_000_000
const maxInviteUseLimit = 9_007_199_254_740_991

var ErrInviteConflict = errors.New("protected invitation conflict")
var ErrInviteCursor = errors.New("protected invitation cursor unavailable")

type InviteCreate struct {
	ID           string `json:"id"`
	TokenHash    string `json:"tokenHash"`
	ExpiresAt    int64  `json:"expiresAt,omitempty"`
	MaxUses      *int64 `json:"maxUses,omitempty"`
	PolicyDigest string `json:"policyDigest"`
	Signature    []byte `json:"signature"`
}

type VerifyInviteCreate func(context.Context, SessionQuery, Principal, InviteCreate, int64) error

type InviteInfo struct {
	ID        string `json:"id"`
	Creator   string `json:"creator"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	MaxUses   int64  `json:"maxUses"`
	Uses      int64  `json:"uses"`
	RevokedAt int64  `json:"revokedAt,omitempty"`
	CanRevoke bool   `json:"canRevoke"`
}

type InviteReceipt struct {
	Invite   InviteInfo `json:"invite"`
	Existing bool       `json:"existing"`
}

type InvitePage struct {
	Invites    []InviteInfo `json:"invites"`
	Next       string       `json:"next,omitempty"`
	CanCreate  bool         `json:"canCreate"`
	PolicyHead string       `json:"policyHead,omitempty"`
}

const inviteColumns = `id,creator_profile_id,created_at,expires_at,max_uses,uses,COALESCE(revoked_at,0)`

func EnsureInviteSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_invites (
		id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, creator_profile_id TEXT NOT NULL, creator_device_id TEXT NOT NULL,
		created_at INTEGER NOT NULL, requested_expiry INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
		policy_digest TEXT NOT NULL, signature BLOB NOT NULL CHECK(length(signature)=64),
		max_uses INTEGER NOT NULL CHECK(max_uses>=0), uses INTEGER NOT NULL DEFAULT 0 CHECK(uses>=0 AND (max_uses=0 OR uses<=max_uses)),
		revoked_at INTEGER
	) STRICT;
	CREATE INDEX IF NOT EXISTS protected_invites_recent ON protected_invites(created_at DESC,id DESC);
	CREATE INDEX IF NOT EXISTS protected_invites_owner ON protected_invites(creator_profile_id,created_at DESC,id DESC);
	CREATE TABLE IF NOT EXISTS protected_invite_admissions (
		profile_id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, invite_id TEXT NOT NULL REFERENCES protected_invites(id),
		operation_id TEXT NOT NULL, request_digest TEXT NOT NULL, request BLOB NOT NULL, accepted_at INTEGER NOT NULL
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_invite_device_keys (
		device_id TEXT PRIMARY KEY, public_key TEXT NOT NULL CHECK(length(public_key)=43)
	) STRICT;
	INSERT OR IGNORE INTO protected_invite_device_keys(device_id,public_key)
		SELECT device_id,json_extract(CAST(request AS TEXT),'$.devicePublicKey') FROM protected_invite_admissions;
	CREATE TABLE IF NOT EXISTS protected_pending_invite_sessions (
		session_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES protected_invite_admissions(device_id),
		token_hash BLOB NOT NULL UNIQUE CHECK(length(token_hash)=32), binding TEXT NOT NULL CHECK(length(binding)=64),
		expires_at INTEGER NOT NULL
	) STRICT;
	CREATE INDEX IF NOT EXISTS protected_pending_invite_session_expiry ON protected_pending_invite_sessions(expires_at);
	CREATE INDEX IF NOT EXISTS protected_pending_invite_session_device ON protected_pending_invite_sessions(device_id,binding)`)
	return err
}

func validInviteHex(value string, length int) bool {
	return len(value) == length && strings.Trim(value, "0123456789abcdef") == ""
}

type inviteGrants struct{ own, viewAll, manageAll bool }

func (s State) inviteGrants(principal Principal, now int64) inviteGrants {
	if !s.PolicyAnchored || !s.hasPolicyDevice(principal) {
		return inviteGrants{}
	}
	member := s.Members[principal.ProfileID]
	return inviteGrants{
		own:       s.CheckGrant(member, Scope{}, "invite.create", now) == Allowed,
		viewAll:   s.CheckGrant(member, Scope{}, "invite.view-all", now) == Allowed,
		manageAll: s.CheckGrant(member, Scope{}, "invite.manage-all", now) == Allowed,
	}
}

func inviteInfoFields(info *InviteInfo) []any {
	return []any{&info.ID, &info.Creator, &info.CreatedAt, &info.ExpiresAt, &info.MaxUses, &info.Uses, &info.RevokedAt}
}

func (s *Store) CreateInvite(ctx context.Context, resolve ResolveSession, verify VerifyInviteCreate, input InviteCreate) (InviteReceipt, error) {
	maxUses := int64(1)
	if input.MaxUses != nil {
		maxUses = *input.MaxUses
	}
	if verify == nil || !validInviteHex(input.ID, 32) || !validInviteHex(input.TokenHash, 64) || maxUses < 0 || maxUses > maxInviteUseLimit ||
		!validInviteHex(input.PolicyDigest, 64) || len(input.Signature) != 64 ||
		input.ExpiresAt < 0 || input.ExpiresAt > maxInviteDate {
		return InviteReceipt{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return InviteReceipt{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return InviteReceipt{}, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return InviteReceipt{}, err
	}
	now := s.now().UnixMilli()
	if !state.inviteGrants(actor, now).own {
		return InviteReceipt{}, MissingGrant
	}
	var previous InviteInfo
	var device, digest, policyDigest string
	var signature []byte
	var requestedExpiry int64
	err = tx.QueryRowContext(ctx, `SELECT `+inviteColumns+`,creator_device_id,token_hash,requested_expiry,policy_digest,signature FROM protected_invites WHERE id=?`,
		input.ID).Scan(append(inviteInfoFields(&previous), &device, &digest, &requestedExpiry, &policyDigest, &signature)...)
	if err == nil {
		if previous.Creator != actor.ProfileID || device != actor.DeviceID || digest != input.TokenHash ||
			requestedExpiry != input.ExpiresAt || previous.MaxUses != maxUses || policyDigest != input.PolicyDigest || !bytes.Equal(signature, input.Signature) {
			return InviteReceipt{}, ErrInviteConflict
		}
		previous.CanRevoke = previous.RevokedAt == 0 && previous.ExpiresAt > now && (previous.MaxUses == 0 || previous.Uses < previous.MaxUses)
		return InviteReceipt{Invite: previous, Existing: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return InviteReceipt{}, err
	}
	expiry := input.ExpiresAt
	if expiry == 0 {
		expiry = now + millisecondsPerDay
	}
	if expiry <= now || expiry > maxInviteDate {
		return InviteReceipt{}, InvalidAction
	}
	if err := verify(ctx, tx, actor, input, maxUses); err != nil {
		return InviteReceipt{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO protected_invites(id,token_hash,creator_profile_id,creator_device_id,
		created_at,requested_expiry,expires_at,max_uses,policy_digest,signature) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(token_hash) DO NOTHING`,
		input.ID, input.TokenHash, actor.ProfileID, actor.DeviceID, now, input.ExpiresAt, expiry, maxUses, input.PolicyDigest, input.Signature)
	if err != nil {
		return InviteReceipt{}, err
	}
	if rows, err := result.RowsAffected(); err != nil {
		return InviteReceipt{}, err
	} else if rows != 1 {
		return InviteReceipt{}, ErrInviteConflict
	}
	if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: "invite.create", Kind: "invite", ObjectID: input.ID}); err != nil {
		return InviteReceipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return InviteReceipt{}, err
	}
	return InviteReceipt{Invite: InviteInfo{ID: input.ID, Creator: actor.ProfileID, CreatedAt: now, ExpiresAt: expiry, MaxUses: maxUses, CanRevoke: true}}, nil
}

func (s *Store) DispatchInvites(ctx context.Context, resolve ResolveSession, before string, deliver func(InvitePage) error) error {
	if before != "" && !validInviteHex(before, 32) {
		return InvalidAction
	}
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		now := s.now().UnixMilli()
		grants := state.inviteGrants(actor, now)
		if !grants.own && !grants.viewAll {
			return MissingGrant
		}
		var boundary sql.NullInt64
		if before != "" {
			err := conn.QueryRowContext(ctx, `SELECT created_at FROM protected_invites WHERE id=? AND (? OR creator_profile_id=?)`,
				before, grants.viewAll, actor.ProfileID).Scan(&boundary)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrInviteCursor
			}
			if err != nil {
				return err
			}
		}
		page := InvitePage{Invites: make([]InviteInfo, 0, invitePageSize), CanCreate: grants.own}
		if grants.own {
			head, err := readPolicyHead(ctx, conn)
			if err != nil {
				return err
			}
			if head.Digest == "" {
				return ErrPolicySignatureRequired
			}
			page.PolicyHead = head.Digest
		}
		rows, err := conn.QueryContext(ctx, `SELECT `+inviteColumns+` FROM protected_invites
			WHERE (? OR creator_profile_id=?) AND (? IS NULL OR (created_at,id)<(?,?))
			ORDER BY created_at DESC,id DESC LIMIT ?`, grants.viewAll, actor.ProfileID, boundary, boundary, before, invitePageSize+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if len(page.Invites) == invitePageSize {
				page.Next = page.Invites[invitePageSize-1].ID
				break
			}
			var invite InviteInfo
			if err := rows.Scan(inviteInfoFields(&invite)...); err != nil {
				return err
			}
			invite.CanRevoke = invite.RevokedAt == 0 && invite.ExpiresAt > now && (invite.MaxUses == 0 || invite.Uses < invite.MaxUses) &&
				(grants.manageAll || (grants.own && invite.Creator == actor.ProfileID))
			page.Invites = append(page.Invites, invite)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		return deliver(page)
	})
}

func (s *Store) RevokeInvite(ctx context.Context, resolve ResolveSession, id string) error {
	if !validInviteHex(id, 32) {
		return InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return err
	}
	now := s.now().UnixMilli()
	grants := state.inviteGrants(actor, now)
	if !grants.own && !grants.manageAll {
		return MissingGrant
	}
	var invite InviteInfo
	err = tx.QueryRowContext(ctx, `SELECT `+inviteColumns+` FROM protected_invites WHERE id=? AND (? OR creator_profile_id=?)`,
		id, grants.manageAll, actor.ProfileID).Scan(inviteInfoFields(&invite)...)
	if errors.Is(err, sql.ErrNoRows) {
		return MissingGrant
	}
	if err != nil {
		return err
	}
	if invite.RevokedAt != 0 || invite.ExpiresAt <= now || (invite.MaxUses != 0 && invite.Uses >= invite.MaxUses) {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE protected_invites SET revoked_at=? WHERE id=?`, now, id); err != nil {
		return err
	}
	if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: "invite.revoke", Kind: "invite", ObjectID: id}); err != nil {
		return err
	}
	return tx.Commit()
}
