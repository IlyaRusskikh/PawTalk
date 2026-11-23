package access

import (
	"context"
	"database/sql"
	"errors"
)

const editCommunity = "server.edit"

var ErrCommunityChanged = errors.New("protected community settings changed")

type CommunityName struct {
	Name     string `json:"name"`
	Revision int64  `json:"revision"`
}

func EnsureCommunityNameSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_community_name (
		id INTEGER PRIMARY KEY CHECK(id=1),
		name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
		revision INTEGER NOT NULL CHECK(revision>0)
	) STRICT`)
	return err
}

func ReadCommunityName(ctx context.Context, query SessionQuery) (CommunityName, error) {
	var current CommunityName
	// Imported servers keep the migration source sealed. Its final name
	// remains the default until the first rename through API 3.
	err := query.QueryRowContext(ctx, `SELECT COALESCE(c.name,s.name),COALESCE(c.revision,s.revision)
		FROM server_state s LEFT JOIN protected_community_name c ON c.id=s.id WHERE s.id=1`).
		Scan(&current.Name, &current.Revision)
	return current, err
}

// RenameCommunity updates public server metadata under the current policy.
func (s *Store) RenameCommunity(ctx context.Context, resolve ResolveSession, input CommunityName) (CommunityName, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CommunityName{}, err
	}
	defer tx.Rollback()
	actor, err := resolve(ctx, tx)
	if err != nil {
		return CommunityName{}, err
	}
	state, _, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return CommunityName{}, err
	}
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) {
		return CommunityName{}, ChannelRestricted
	}
	now := s.now().UnixMilli()
	if decision := state.CheckGrant(state.Members[actor.ProfileID], Scope{}, editCommunity, now); decision != Allowed {
		return CommunityName{}, decision
	}
	current, err := ReadCommunityName(ctx, tx)
	if err != nil {
		return CommunityName{}, err
	}
	if current.Name == input.Name && (current.Revision == input.Revision || current.Revision == input.Revision+1) {
		return current, nil
	}
	if current.Revision != input.Revision {
		return CommunityName{}, ErrCommunityChanged
	}
	next := CommunityName{Name: input.Name, Revision: current.Revision + 1}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_community_name(id,name,revision) VALUES(1,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision`, next.Name, next.Revision); err != nil {
		return CommunityName{}, err
	}
	if err := recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor.ProfileID, Action: "server.rename", Kind: "server",
		ObjectID: "name"}); err != nil {
		return CommunityName{}, err
	}
	return next, tx.Commit()
}
