package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

func (s *membershipStore) createChannel(ctx context.Context, token, kind, name, requestID string) (string, error) {
	name = strings.TrimSpace(name)
	if (kind != "text" && kind != "voice") || !validMemberLabel(name) {
		return "", memberError(400, "INVALID_CHANNEL")
	}
	// Derive the opaque ID from actor/request in the transaction so retries return
	// the same channel without storing an unbounded response body.
	var id string
	payload, _ := json.Marshal([]string{kind, name})
	err := s.mutate(ctx, token, requestID, "channel.create", "channel.manage", payload, func(tx *sql.Tx, access memberAccess) error {
		id = publicKeyID([]byte(access.DeviceID + ":" + requestID))[:32]
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM channels").Scan(&count); err != nil {
			return err
		}
		if count >= 1000 {
			return memberError(409, "CHANNEL_LIMIT")
		}
		_, err := tx.ExecContext(ctx, "INSERT INTO channels(channel_id,kind,name,position,created_by_profile_id) VALUES(?,?,?,COALESCE((SELECT MAX(position)+1 FROM channels),0),?)", id, kind, name, access.ProfileID)
		return err
	})
	if err != nil {
		return "", err
	}
	if id == "" {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return "", err
		}
		defer tx.Rollback()
		access, err := s.sessionAccessTx(ctx, tx, token)
		if err != nil {
			return "", err
		}
		id = publicKeyID([]byte(access.DeviceID + ":" + requestID))[:32]
	}
	return id, nil
}

func (s *membershipStore) patchChannel(ctx context.Context, token, id, name, requestID string, position int, revision int64) error {
	name = strings.TrimSpace(name)
	if !validHexID(id, 32) || !validMemberLabel(name) || position < 0 || position > 1000 || revision < 1 {
		return memberError(400, "INVALID_CHANNEL")
	}
	payload, _ := json.Marshal([]any{id, name, position, revision})
	return s.mutate(ctx, token, requestID, "channel.patch", "channel.manage", payload, func(tx *sql.Tx, _ memberAccess) error {
		result, err := tx.ExecContext(ctx, "UPDATE channels SET name=?,position=?,revision=revision+1 WHERE channel_id=? AND revision=?", name, position, id, revision)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return memberError(409, "CHANNEL_CHANGED")
		}
		return nil
	})
}

func (s *membershipStore) deleteChannel(ctx context.Context, token, id, requestID string) error {
	if !validHexID(id, 32) {
		return memberError(400, "INVALID_CHANNEL")
	}
	return s.mutate(ctx, token, requestID, "channel.delete", "channel.manage", []byte(id), func(tx *sql.Tx, _ memberAccess) error {
		var protected sql.NullString
		err := tx.QueryRowContext(ctx, "SELECT protected_kind FROM channels WHERE channel_id=?", id).Scan(&protected)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(404, "CHANNEL_NOT_FOUND")
		}
		if err != nil {
			return err
		}
		if protected.Valid {
			return memberError(403, "PROTECTED_CHANNEL")
		}
		// LiveKit removal is requested by the transport layer; all authorized slots
		// and channel content disappear atomically through foreign keys.
		_, err = tx.ExecContext(ctx, "DELETE FROM channels WHERE channel_id=?", id)
		return err
	})
}

// Reorder a complete kind in one transaction; concurrent edits fail without partial moves.
type channelOrderItem struct {
	ID       string `json:"id"`
	Revision int64  `json:"revision"`
}

func (s *membershipStore) reorderChannels(ctx context.Context, token, kind, requestID string, items []channelOrderItem) error {
	if (kind != "voice" && kind != "text") || len(items) < 1 || len(items) > 1000 {
		return memberError(400, "INVALID_CHANNEL")
	}
	seen := map[string]bool{}
	for _, item := range items {
		if !validHexID(item.ID, 32) || item.Revision < 1 || seen[item.ID] {
			return memberError(400, "INVALID_CHANNEL")
		}
		seen[item.ID] = true
	}
	payload, _ := json.Marshal([]any{kind, items})
	return s.mutate(ctx, token, requestID, "channel.order", "channel.manage", payload, func(tx *sql.Tx, _ memberAccess) error {
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM channels WHERE kind=?", kind).Scan(&count); err != nil {
			return err
		}
		if count != len(items) {
			return memberError(409, "CHANNEL_CHANGED")
		}
		for position, item := range items {
			result, err := tx.ExecContext(ctx, "UPDATE channels SET position=?,revision=revision+1 WHERE channel_id=? AND kind=? AND revision=?", position, item.ID, kind, item.Revision)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if n != 1 {
				return memberError(409, "CHANNEL_CHANGED")
			}
		}
		return nil
	})
}
