package access

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"strconv"
)

type CompletedPollMessages struct {
	Author       string
	Result       uint64
	ResultAuthor string
}

type ResolveCompletedPoll func(context.Context, *sql.Tx, string, uint64, int64) (CompletedPollMessages, error)

func (s *Store) DeleteCompletedPoll(ctx context.Context, resolve ResolveSession, lookup ResolveCompletedPoll, channel string, position uint64) error {
	if position == 0 || position >= math.MaxInt64 {
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
	if !state.PolicyAnchored || !state.canUseDevice(actor) || !state.CanDeliver(actor.ProfileID, channel, position) {
		return ChannelRestricted
	}
	now := s.now().UnixMilli()
	if grant := state.CheckGrant(state.Members[actor.ProfileID], state.scope(state.Channels[channel]), "poll.delete-completed", now); grant != Allowed {
		return grant
	}
	poll, err := loadCompletedPollMessages(ctx, tx, lookup, channel, position, now)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelRestricted
	}
	if err != nil {
		return err
	}
	if poll.Result != 0 && (poll.Result <= position || !state.CanDeliver(actor.ProfileID, channel, poll.Result)) {
		return ChannelRestricted
	}
	var deleted bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM protected_message_deletions WHERE channel_id=? AND position=?)`,
		channel, position).Scan(&deleted); err != nil {
		return err
	}
	if deleted {
		return nil
	}
	if err := deleteAuditedPoll(ctx, tx, actor.ProfileID, channel, position, poll, now); err != nil {
		return err
	}
	return tx.Commit()
}

func loadCompletedPollMessages(ctx context.Context, tx *sql.Tx, lookup ResolveCompletedPoll, channel string,
	position uint64, now int64) (CompletedPollMessages, error) {
	var poll CompletedPollMessages
	err := tx.QueryRowContext(ctx, `SELECT p.author_profile_id,COALESCE(r.position,0) FROM protected_polls p
		LEFT JOIN protected_poll_closures c ON c.channel_id=p.channel_id AND c.position=p.position
		LEFT JOIN protected_poll_results r ON r.channel_id=p.channel_id AND r.original_position=p.position
		WHERE p.channel_id=? AND p.position=? AND (p.closed_at IS NOT NULL OR p.closes_at<=? OR c.closed_at IS NOT NULL)`,
		channel, position, now).Scan(&poll.Author, &poll.Result)
	if errors.Is(err, sql.ErrNoRows) && lookup != nil {
		poll, err = lookup(ctx, tx, channel, position, now)
		if err == nil && poll.Result == 0 {
			err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT position FROM protected_poll_results
				WHERE channel_id=? AND original_position=?),0)`, channel, position).Scan(&poll.Result)
		}
	}
	return poll, err
}

func deleteAuditedPoll(ctx context.Context, tx *sql.Tx, actor, channel string, position uint64, poll CompletedPollMessages, now int64) error {
	if err := removeRetainedPoll(ctx, tx, channel, position, poll); err != nil {
		return err
	}
	return recordAudit(ctx, tx, AuditEvent{At: now, Actor: actor, Action: "poll.delete-completed",
		Kind: "poll", ObjectID: strconv.FormatUint(position, 10), ChannelID: channel, Position: position})
}

func removeRetainedPoll(ctx context.Context, tx *sql.Tx, channel string, position uint64, poll CompletedPollMessages) error {
	if err := removeRetainedMessage(ctx, tx, channel, position, poll.Author); err != nil {
		return err
	}
	if poll.Result != 0 {
		if err := removeRetainedMessage(ctx, tx, channel, poll.Result, poll.ResultAuthor); err != nil {
			return err
		}
	}
	return nil
}
