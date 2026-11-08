package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
)

const defaultChatStorage = 128 * 1024 * 1024

var errChatStorage = errors.New("chat storage budget exceeded")

func chatStorageLimit() (int64, error) {
	raw := os.Getenv("PAWTALK_CHAT_MAX_MB")
	if raw == "" {
		return defaultChatStorage, nil
	}
	mb, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || mb < 0 || mb > math.MaxInt64/(1024*1024) {
		return 0, fmt.Errorf("PAWTALK_CHAT_MAX_MB must be a non-negative integer (0 means unlimited)")
	}
	return mb * 1024 * 1024, nil
}

// Include SQLite table/index pages, profiles and attachment payloads in one disk
// budget. FULL auto-vacuum releases freed pages at commit, including after a
// configuration decrease. Temporary rollback journals are outside this budget.
func (s *chatStore) enforceStorage(ctx context.Context, tx *sql.Tx, protectedMessage int64, protectedProfiles ...string) error {
	if s.maxBytes == 0 {
		return nil
	}
	protectedProfile := ""
	if len(protectedProfiles) > 0 {
		protectedProfile = protectedProfiles[0]
	}
	for {
		var pages, free, size int64
		if err := tx.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pages); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, "PRAGMA freelist_count").Scan(&free); err != nil {
			return err
		}
		if err := tx.QueryRowContext(ctx, "PRAGMA page_size").Scan(&size); err != nil {
			return err
		}
		if (pages-free)*size <= s.maxBytes {
			return nil
		}
		// Unreferenced cached avatars should not displace message history.
		result, err := tx.ExecContext(ctx, `DELETE FROM chat_profiles WHERE revision=(
		 SELECT revision FROM chat_profiles p WHERE NOT (p.feed=? AND p.profile_id=?) AND NOT EXISTS (
		 SELECT 1 FROM chat_messages m WHERE m.feed=p.feed AND m.author_id=p.profile_id)
		 ORDER BY revision LIMIT 1)`, s.feed, protectedProfile)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count > 0 {
			continue
		}
		var id int64
		var feed, attachment string
		err = tx.QueryRowContext(ctx, "SELECT id,feed,attachment_id FROM chat_messages WHERE id<>? ORDER BY id LIMIT 1", protectedMessage).Scan(&id, &feed, &attachment)
		if errors.Is(err, sql.ErrNoRows) {
			return errChatStorage
		}
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM chat_messages WHERE id=?", id); err != nil {
			return err
		}
		if attachment != "" {
			if _, err = tx.ExecContext(ctx, `DELETE FROM chat_attachments WHERE feed=? AND id=? AND NOT EXISTS (
			 SELECT 1 FROM chat_messages m WHERE m.feed=chat_attachments.feed AND m.attachment_id=chat_attachments.id)`, feed, attachment); err != nil {
				return err
			}
		}
	}
}
