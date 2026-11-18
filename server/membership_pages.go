package main

import (
	"context"
	"slices"
	"strings"
)

type memberMessageSelection struct {
	Around int64
	IDs    []int64
}

func (s *membershipStore) messagePage(ctx context.Context, token, channel string, limit int, before, after, readAfter int64, selections ...memberMessageSelection) (memberMessagePage, error) {
	page := memberMessagePage{Messages: []memberMessage{}}
	if !validHexID(channel, 32) || limit < 1 || limit > 500 || before < 0 || after < 0 || readAfter < 0 || (before > 0 && after > 0) {
		return page, memberError(400, "INVALID_PAGE")
	}
	var selection memberMessageSelection
	if len(selections) > 0 {
		selection = selections[0]
	}
	if selection.Around < 0 || len(selection.IDs) > 500 || (selection.Around > 0 && (len(selection.IDs) > 0 || before > 0 || after > 0)) || (len(selection.IDs) > 0 && (before > 0 || after > 0)) {
		return page, memberError(400, "INVALID_PAGE")
	}
	for _, id := range selection.IDs {
		if id < 1 {
			return page, memberError(400, "INVALID_PAGE")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return page, err
	}
	if !access.allows("chat.read") {
		return page, memberError(403, "FORBIDDEN")
	}
	if err = memberTextChannelTx(ctx, tx, channel); err != nil {
		return page, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MIN(message_id),0),COALESCE(MAX(message_id),0) FROM messages WHERE channel_id=?", channel).Scan(&page.First, &page.Last); err != nil {
		return page, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT message_revision FROM channels WHERE channel_id=?", channel).Scan(&page.Revision); err != nil {
		return page, err
	}
	clause, order := "", "DESC"
	args := []any{channel}
	if before > 0 {
		clause = " AND m.message_id<?"
		args = append(args, before)
	}
	if after > 0 {
		clause = " AND m.message_id>?"
		order = "ASC"
		args = append(args, after)
	}
	if selection.Around > 0 {
		clause = " AND m.message_id>=COALESCE((SELECT message_id FROM messages WHERE channel_id=? AND message_id<=? ORDER BY message_id DESC LIMIT 1 OFFSET ?),(SELECT MIN(message_id) FROM messages WHERE channel_id=?))"
		args = append(args, channel, selection.Around, limit/2, channel)
		order = "ASC"
	}
	if len(selection.IDs) > 0 {
		clause = " AND m.message_id IN (" + strings.TrimSuffix(strings.Repeat("?,", len(selection.IDs)), ",") + ")"
		for _, id := range selection.IDs {
			args = append(args, id)
		}
		order = "ASC"
		limit = len(selection.IDs)
	}
	args = append(args, limit)
	rows, err := tx.QueryContext(ctx, "SELECT "+memberMessageColumns+` FROM messages m WHERE m.channel_id=?`+clause+" ORDER BY m.message_id "+order+" LIMIT ?", args...)
	if err != nil {
		return page, err
	}
	for rows.Next() {
		v, err := scanMemberMessage(rows)
		if err != nil {
			rows.Close()
			return page, err
		}
		page.Messages = append(page.Messages, v)
	}
	if err = closeMemberRows(rows); err != nil {
		return page, err
	}
	if order == "DESC" {
		slices.Reverse(page.Messages)
	}
	if len(page.Messages) > 0 {
		page.HasOlder = page.First < page.Messages[0].ID
		page.HasNewer = page.Last > page.Messages[len(page.Messages)-1].ID
	}
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages m WHERE channel_id=? AND message_id>? AND (EXISTS(SELECT 1 FROM system_messages sm WHERE sm.message_id=m.message_id) OR (author_profile_id<>? AND author_profile_id NOT IN(SELECT source_profile_id FROM profile_bindings WHERE target_profile_id=?)))`, channel, readAfter, access.EffectiveProfileID, access.EffectiveProfileID).Scan(&page.Unread); err != nil {
		return page, err
	}
	return page, tx.Commit()
}
