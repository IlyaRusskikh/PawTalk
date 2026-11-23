package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

const EditOwnNickname = "profile.edit-self"
const editOtherNickname = "profile.edit-other"
const NicknameSchema = `CREATE TABLE IF NOT EXISTS protected_nicknames (
	profile_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;`

var ErrNicknameChanged = errors.New("protected nickname changed")

type NicknameUpdate struct {
	ChannelID string `json:"channelId,omitempty"`
	Name      string `json:"name"`
	Revision  int64  `json:"revision"`
}

type NicknameState struct {
	Name     string `json:"name"`
	Revision int64  `json:"revision"`
}

func nicknameAuthority(state State, actor Principal, targetID, channelID string, now int64) Decision {
	subject, target := state.Members[actor.ProfileID], state.Members[targetID]
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !target.Active {
		return ChannelRestricted
	}
	if subject.ID == target.ID {
		return state.CheckGrant(subject, Scope{}, EditOwnNickname, now)
	}
	if channelID == "" {
		if state.CheckGrant(subject, Scope{}, "member.list", now) != Allowed {
			return ChannelRestricted
		}
	} else if state.Channels[channelID].Kind != "text" ||
		!state.CanDeliver(subject.ID, channelID, 0) || !state.CanDeliver(target.ID, channelID, 0) {
		return ChannelRestricted
	}
	return state.CheckAction(subject, target, Scope{}, editOtherNickname, false, now)
}

func readNicknameOverride(ctx context.Context, query SessionQuery, profileID string) (NicknameState, error) {
	var current NicknameState
	err := query.QueryRowContext(ctx, "SELECT name,revision FROM protected_nicknames WHERE profile_id=?", profileID).
		Scan(&current.Name, &current.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return current, err
}

func rosterNicknameDigest(ctx context.Context, conn *sql.Conn, state State, channelID string) (string, error) {
	rows, err := conn.QueryContext(ctx, "SELECT profile_id,name,revision FROM protected_nicknames ORDER BY profile_id")
	if err != nil {
		return "", err
	}
	defer rows.Close()
	digest := sha256.New()
	for rows.Next() {
		var profileID string
		var nickname NicknameState
		if err := rows.Scan(&profileID, &nickname.Name, &nickname.Revision); err != nil {
			return "", err
		}
		if state.Members[profileID].Active && (channelID == "" || state.CanDeliver(profileID, channelID, 0)) {
			fmt.Fprintf(digest, "%s\x00%d\x00%s\x00", profileID, nickname.Revision, nickname.Name)
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), rows.Err()
}

func (s *Store) DispatchNickname(ctx context.Context, resolve ResolveSession, profileID, channelID string,
	deliver func(SessionQuery, NicknameState) error) error {
	if !isDigest(profileID) || channelID != "" && !validRotationID(channelID) {
		return InvalidAction
	}
	return s.dispatchPolicyTransaction(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		if decision := nicknameAuthority(state, actor, profileID, channelID, s.now().UnixMilli()); decision != Allowed {
			return decision
		}
		current, err := readNicknameOverride(ctx, conn, profileID)
		if err != nil {
			return err
		}
		return deliver(conn, current)
	})
}

func (s *Store) ChangeNickname(ctx context.Context, resolve ResolveSession, profileID string, input NicknameUpdate) (NicknameState, error) {
	name := strings.TrimSpace(input.Name)
	if !isDigest(profileID) || input.ChannelID != "" && !validRotationID(input.ChannelID) ||
		input.Revision < 0 || input.Revision >= 1<<53-1 || !utf8.ValidString(name) ||
		utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 32 || strings.ContainsFunc(name, unicode.IsControl) {
		return NicknameState{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return NicknameState{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return NicknameState{}, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return NicknameState{}, err
	}
	now := s.now().UnixMilli()
	if decision := nicknameAuthority(state, actor, profileID, input.ChannelID, now); decision != Allowed {
		return NicknameState{}, decision
	}
	current, err := readNicknameOverride(ctx, tx, profileID)
	if err != nil {
		return NicknameState{}, err
	}
	if current.Name == name && (current.Revision == input.Revision || current.Revision == input.Revision+1) {
		return current, nil
	}
	if current.Revision != input.Revision {
		return NicknameState{}, ErrNicknameChanged
	}
	result := NicknameState{Name: name, Revision: current.Revision + 1}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_nicknames(profile_id,name,revision) VALUES(?,?,?)
		ON CONFLICT(profile_id) DO UPDATE SET name=excluded.name,revision=excluded.revision`,
		profileID, result.Name, result.Revision); err != nil {
		return NicknameState{}, err
	}
	if actor.ProfileID != profileID {
		if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: editOtherNickname,
			Kind: "member", ObjectID: profileID, ChannelID: input.ChannelID}); err != nil {
			return NicknameState{}, err
		}
	}
	return result, tx.Commit()
}
