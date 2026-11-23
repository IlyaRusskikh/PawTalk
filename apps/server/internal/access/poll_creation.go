package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

type MessagePoll struct {
	OptionCount  int
	Duration     int64
	Multiple     bool
	Anonymous    bool
	Intermediate bool
}

func (poll *MessagePoll) valid() bool {
	if poll == nil {
		return true
	}
	if poll.OptionCount < 2 || poll.OptionCount > 10 {
		return false
	}
	switch poll.Duration {
	case 3600, 14400, 28800, 86400, 259200, 604800, 1209600:
		return true
	default:
		return false
	}
}

func (poll MessagePoll) Digest() string {
	return hexHash([]byte(strings.Join([]string{"pawtalk-protected-poll-v1", strconv.Itoa(poll.OptionCount),
		strconv.FormatInt(poll.Duration, 10), strconv.FormatBool(poll.Multiple), strconv.FormatBool(poll.Anonymous),
		strconv.FormatBool(poll.Intermediate)}, ":")))
}

func insertMessagePoll(ctx context.Context, tx *sql.Tx, attempt MessageAttempt, actor Principal, position uint64, now int64) error {
	if attempt.Poll == nil {
		return nil
	}
	body, err := json.Marshal(attempt.Poll)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO protected_polls(channel_id,position,author_profile_id,closes_at,definition) VALUES(?,?,?,?,?)",
		attempt.ChannelID, position, actor.ProfileID, now+attempt.Poll.Duration*1000, string(body))
	return err
}

func resolveMessagePoll(ctx context.Context, query SessionQuery, imported ResolvePoll, channel string, position uint64) (PollDefinition, error) {
	var poll PollDefinition
	var raw string
	err := query.QueryRowContext(ctx, `SELECT p.author_profile_id,p.closes_at,p.closed_at,p.definition FROM protected_polls p
		JOIN protected_messages m ON m.channel_id=p.channel_id AND m.position=p.position
		WHERE p.channel_id=? AND p.position=?`, channel, position).Scan(&poll.Author, &poll.ClosesAt, &poll.ClosedAt, &raw)
	if errors.Is(err, sql.ErrNoRows) && imported != nil {
		return imported(ctx, query, channel, position)
	}
	if err != nil {
		return poll, err
	}
	var definition MessagePoll
	if err := json.Unmarshal([]byte(raw), &definition); err != nil || !definition.valid() {
		return poll, InvalidPolicy
	}
	poll.OptionCount, poll.Multiple, poll.Anonymous, poll.Intermediate =
		definition.OptionCount, definition.Multiple, definition.Anonymous, definition.Intermediate
	return poll, nil
}
