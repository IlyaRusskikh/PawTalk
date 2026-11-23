package access

import (
	"context"
	"database/sql"
	"errors"
)

var ErrStorageLimit = errors.New("protected history storage limit")

// WithStorageRetention enables the host quota for content publications. The
// check must use the write transaction, including its uncommitted pages.
func (s *Store) WithStorageRetention(overLimit func(context.Context, *sql.Tx) (bool, error)) *Store {
	retained := *s
	retained.storageOverLimit = overLimit
	return &retained
}

type storagePosition struct {
	channel  string
	position uint64
}

func (s *Store) enforceStorageRetention(ctx context.Context, tx *sql.Tx, protected ...storagePosition) error {
	if s.storageOverLimit == nil {
		return nil
	}
	overLimit, err := s.storageOverLimit(ctx, tx)
	if err != nil || !overLimit {
		return err
	}
	now := s.now().UnixMilli()
	if _, err := tx.ExecContext(ctx, "DELETE FROM protected_attachments WHERE position IS NULL AND created_at<=?", now-pendingAttachmentTTL.Milliseconds()); err != nil {
		return err
	}
	keep := make(map[storagePosition]bool, len(protected))
	for _, position := range protected {
		keep[position] = true
	}
	var after int64
	for {
		overLimit, err := s.storageOverLimit(ctx, tx)
		if err != nil || !overLimit {
			return err
		}
		var candidate storagePosition
		var author string
		// Only mutable protected payloads reclaim pages. Frozen imported rows
		// and the immutable migration/key commitments are outside this scan.
		err = tx.QueryRowContext(ctx, `SELECT rowid,channel_id,position,profile_id FROM protected_messages
			WHERE rowid>? ORDER BY rowid LIMIT 1`, after).Scan(&after, &candidate.channel, &candidate.position, &author)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrStorageLimit
		}
		if err != nil {
			return err
		}
		if keep[candidate] {
			continue
		}
		poll, err := loadCompletedPollMessages(ctx, tx, nil, candidate.channel, candidate.position, now)
		switch {
		case err == nil:
			if keep[storagePosition{candidate.channel, poll.Result}] {
				continue
			}
			err = removeRetainedPoll(ctx, tx, candidate.channel, candidate.position, poll)
		case errors.Is(err, sql.ErrNoRows):
			err = removeRetainedMessage(ctx, tx, candidate.channel, candidate.position, author)
		}
		if err != nil {
			return err
		}
	}
}
