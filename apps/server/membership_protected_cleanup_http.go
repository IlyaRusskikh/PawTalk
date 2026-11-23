package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"pawtalk/server/internal/access"
)

func importedCleanupPositions(ctx context.Context, tx *sql.Tx, channel, target string, after uint64, since, through int64, limit int) ([]uint64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT i.position FROM protected_migration_message_positions i
		JOIN messages m ON m.message_id=i.message_id AND m.channel_id=i.channel_id
		JOIN protected_migration_records r ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
		LEFT JOIN profile_bindings b ON b.source_profile_id=m.author_profile_id
		WHERE i.channel_id=? AND COALESCE(b.target_profile_id,m.author_profile_id)=?
		AND i.position>? AND m.sent_at BETWEEN ? AND ?
		AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=i.channel_id AND d.position=i.position)
		ORDER BY i.position LIMIT ?`, channel, target, after, since, through, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var positions []uint64
	for rows.Next() {
		var position uint64
		if err := rows.Scan(&position); err != nil {
			return nil, err
		}
		positions = append(positions, position)
	}
	return positions, rows.Err()
}

func (p *protectedRuntime) moderationCleanupSources() access.ModerationCleanupSources {
	if p.importedProfileNames == nil {
		return access.ModerationCleanupSources{}
	}
	return access.ModerationCleanupSources{
		ImportedPositions: importedCleanupPositions,
		ImportedMessage:   resolveImportedProtectedMessage,
		ImportedPoll:      resolveImportedCompletedPoll,
	}
}

func (p *protectedRuntime) previewModerationCleanupHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Target string `json:"target"`
		Action string `json:"action"`
		Window string `json:"window"`
	}
	if _, err := decodeMemberJSON(w, r, 512, &input); err != nil {
		memberFail(w, err)
		return
	}
	preview, err := access.NewStoreWithClock(p.store.db, p.store.now).PreviewModerationCleanup(r.Context(),
		p.resolveSession(memberBearer(r)), p.moderationCleanupSources(), input.Target, "member."+input.Action, input.Window)
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, preview)
}

func (p *protectedRuntime) applyModerationCleanupHTTP(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID          string `json:"id"`
		OperationID string `json:"operationId"`
	}
	if _, err := decodeMemberJSON(w, r, 512, &input); err != nil {
		memberFail(w, err)
		return
	}
	count, err := access.NewStoreWithClock(p.store.db, p.store.now).ApplyModerationCleanup(r.Context(),
		p.resolveSession(memberBearer(r)), p.moderationCleanupSources(), input.ID, input.OperationID)
	if errors.Is(err, access.ErrCleanupChanged) {
		memberFail(w, memberError(http.StatusConflict, "PROTECTED_CLEANUP_CHANGED"))
		return
	}
	if err != nil {
		protectedPolicyFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]int64{"removed": count})
}
