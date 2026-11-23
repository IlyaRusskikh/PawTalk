package access

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"slices"
)

var ErrPollClosed = errors.New("protected poll is closed")

func EnsurePollVotingSchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_polls (
		channel_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0),
		author_profile_id TEXT NOT NULL, closes_at INTEGER NOT NULL, closed_at INTEGER, definition TEXT NOT NULL,
		PRIMARY KEY(channel_id,position)
	) STRICT;
	CREATE INDEX IF NOT EXISTS protected_polls_deadline ON protected_polls(closes_at);
	CREATE TABLE IF NOT EXISTS protected_poll_results (
		channel_id TEXT NOT NULL, position INTEGER NOT NULL, original_position INTEGER NOT NULL,
		record TEXT NOT NULL, PRIMARY KEY(channel_id,position), UNIQUE(channel_id,original_position),
		CHECK(original_position>0 AND original_position<position)
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_poll_closures (
		channel_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0),
		closed_at INTEGER NOT NULL, counts TEXT NOT NULL, total INTEGER NOT NULL CHECK(total>=0),
		PRIMARY KEY(channel_id,position)
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_poll_ballots (
		channel_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0),
		profile_id TEXT NOT NULL, choices TEXT NOT NULL,
		PRIMARY KEY(channel_id,position,profile_id)
	) STRICT;
	CREATE TABLE IF NOT EXISTS protected_poll_vote_receipts (
		device_id TEXT NOT NULL, operation_id TEXT NOT NULL, profile_id TEXT NOT NULL,
		channel_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0), choices_digest TEXT NOT NULL,
		PRIMARY KEY(device_id,operation_id)
	) STRICT`)
	return err
}

type PollDefinition struct {
	Author       string
	LegacyID     string
	OptionCount  int
	ClosesAt     int64
	ClosedAt     *int64
	Multiple     bool
	Anonymous    bool
	Intermediate bool
}

type ResolvePoll func(context.Context, SessionQuery, string, uint64) (PollDefinition, error)

type PollState struct {
	ClosesAt     int64         `json:"closesAt"`
	ClosedAt     *int64        `json:"closedAt"`
	Multiple     bool          `json:"multiple"`
	Anonymous    bool          `json:"anonymous"`
	Intermediate bool          `json:"intermediate"`
	CanVote      bool          `json:"canVote"`
	CanClose     bool          `json:"canClose"`
	Total        int           `json:"total"`
	Counts       []int         `json:"counts"`
	Own          []int         `json:"own"`
	Voters       [][]PollVoter `json:"voters,omitempty"`
}

type PollVoter struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type pollGrants struct {
	Vote, Close Decision
}

func (s *Store) pollAccess(ctx context.Context, query SessionQuery, state State, actor Principal, lookup ResolvePoll,
	channel string, position uint64) (PollDefinition, pollGrants, error) {
	if !state.PolicyAnchored || !state.canUseDevice(actor) || !state.CanDeliver(actor.ProfileID, channel, position) {
		return PollDefinition{}, pollGrants{}, ChannelRestricted
	}
	poll, err := resolveMessagePoll(ctx, query, lookup, channel, position)
	if errors.Is(err, sql.ErrNoRows) {
		err = ChannelRestricted
	}
	if err != nil {
		return poll, pollGrants{}, err
	}
	if poll.OptionCount < 2 || poll.OptionCount > 10 {
		return poll, pollGrants{}, InvalidPolicy
	}
	var closed int64
	err = query.QueryRowContext(ctx, "SELECT closed_at FROM protected_poll_closures WHERE channel_id=? AND position=?",
		channel, position).Scan(&closed)
	if err == nil {
		poll.ClosedAt = &closed
	} else if !errors.Is(err, sql.ErrNoRows) {
		return poll, pollGrants{}, err
	}
	now := s.now().UnixMilli()
	if poll.ClosedAt == nil && now >= poll.ClosesAt {
		poll.ClosedAt = &poll.ClosesAt
	}
	subject := state.Members[actor.ProfileID]
	timeout, err := readTimeout(ctx, query, subject)
	if err != nil {
		return poll, pollGrants{}, err
	}
	subject.TimeoutUntil = timeout.Deadline
	scope := state.scope(state.Channels[channel])
	closePermission := "poll.close-other"
	if actor.ProfileID == poll.Author {
		closePermission = "message.send"
	}
	return poll, pollGrants{Vote: state.CheckGrant(subject, scope, "poll.vote", now),
		Close: state.CheckGrant(subject, scope, closePermission, now)}, nil
}

type pollQuery interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readPollState(ctx context.Context, db pollQuery, channel string, position uint64, profile string, poll PollDefinition, grant Decision,
	visibleVoter func(string) bool) (PollState, error) {
	current := PollState{ClosesAt: poll.ClosesAt, ClosedAt: poll.ClosedAt, Multiple: poll.Multiple, Anonymous: poll.Anonymous,
		Intermediate: poll.Intermediate, CanVote: poll.ClosedAt == nil && grant == Allowed, Counts: []int{}, Own: []int{}}
	visible := poll.Intermediate || poll.ClosedAt != nil
	if visible {
		current.Counts = make([]int, poll.OptionCount)
		if !poll.Anonymous {
			current.Voters = make([][]PollVoter, poll.OptionCount)
			for i := range current.Voters {
				current.Voters[i] = []PollVoter{}
			}
		}
	}
	query := `SELECT profile_id,choices FROM protected_poll_ballots WHERE channel_id=? AND position=?`
	args := []any{channel, position}
	if poll.LegacyID != "" {
		query += ` UNION ALL SELECT v.profile_id,v.choices FROM poll_votes v WHERE v.poll_id=?
			AND NOT EXISTS(SELECT 1 FROM protected_poll_ballots b
				WHERE b.channel_id=? AND b.position=? AND b.profile_id=v.profile_id)`
		args = append(args, poll.LegacyID, channel, position)
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return current, err
	}
	defer rows.Close()
	for rows.Next() {
		var voter, raw string
		var choices []int
		if err := rows.Scan(&voter, &raw); err != nil {
			return current, err
		}
		if json.Unmarshal([]byte(raw), &choices) != nil || !validPollChoices(choices, poll.OptionCount, poll.Multiple) {
			return current, InvalidPolicy
		}
		if len(choices) == 0 {
			continue
		}
		current.Total++
		if voter == profile {
			current.Own = choices
		}
		if visible {
			showVoter := !poll.Anonymous && visibleVoter != nil && visibleVoter(voter)
			for _, option := range choices {
				current.Counts[option]++
				if showVoter && len(current.Voters[option]) < 10000 {
					current.Voters[option] = append(current.Voters[option], PollVoter{ID: voter})
				}
			}
		}
	}
	return current, rows.Err()
}

func validPollChoices(choices []int, options int, multiple bool) bool {
	if len(choices) > options || len(choices) > 1 && !multiple {
		return false
	}
	var seen [10]bool
	for _, option := range choices {
		if option < 0 || option >= options || seen[option] {
			return false
		}
		seen[option] = true
	}
	return true
}

func (s *Store) DispatchPoll(ctx context.Context, resolve ResolveSession, lookup ResolvePoll,
	channel string, position uint64, deliver func(PollState) error) error {
	if position == 0 || position >= math.MaxInt64 {
		return InvalidAction
	}
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		poll, grant, err := s.pollAccess(ctx, conn, state, actor, lookup, channel, position)
		if err != nil {
			return err
		}
		current, err := readPollState(ctx, conn, channel, position, actor.ProfileID, poll, grant.Vote, func(profile string) bool {
			return state.CanDeliver(profile, channel, 0)
		})
		if err != nil {
			return err
		}
		current.CanClose = poll.ClosedAt == nil && grant.Close == Allowed
		return deliver(current)
	})
}

func (s *Store) VotePoll(ctx context.Context, resolve ResolveSession, lookup ResolvePoll, channel string, position uint64,
	operationID string, choices []int) error {
	if position == 0 || position >= math.MaxInt64 || !validRotationID(operationID) || !validPollChoices(choices, 10, true) {
		return InvalidAction
	}
	sorted := append([]int{}, choices...)
	slices.Sort(sorted)
	body, err := json.Marshal(sorted)
	if err != nil {
		return err
	}
	digest := hexHash(body)
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
	poll, grant, err := s.pollAccess(ctx, tx, state, actor, lookup, channel, position)
	if err != nil {
		return err
	}
	if grant.Vote != Allowed {
		return grant.Vote
	}
	var priorChannel, priorProfile, priorDigest string
	var priorPosition uint64
	err = tx.QueryRowContext(ctx, `SELECT profile_id,channel_id,position,choices_digest FROM protected_poll_vote_receipts
		WHERE device_id=? AND operation_id=?`, actor.DeviceID, operationID).Scan(&priorProfile, &priorChannel, &priorPosition, &priorDigest)
	if err == nil {
		if priorProfile != actor.ProfileID || priorChannel != channel || priorPosition != position || priorDigest != digest {
			return ErrMessageConflict
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if poll.ClosedAt != nil {
		return ErrPollClosed
	}
	if !validPollChoices(sorted, poll.OptionCount, poll.Multiple) {
		return InvalidAction
	}
	// An empty overlay is a withdrawal, including for a frozen API 2 ballot.
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_poll_ballots(channel_id,position,profile_id,choices) VALUES(?,?,?,?)
		ON CONFLICT(channel_id,position,profile_id) DO UPDATE SET choices=excluded.choices`, channel, position, actor.ProfileID, string(body)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_poll_vote_receipts(device_id,operation_id,profile_id,channel_id,position,choices_digest)
		VALUES(?,?,?,?,?,?)`, actor.DeviceID, operationID, actor.ProfileID, channel, position, digest); err != nil {
		return err
	}
	return tx.Commit()
}
