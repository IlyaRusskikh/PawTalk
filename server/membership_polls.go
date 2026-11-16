package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"slices"
	"time"
)

type memberPollCreate struct {
	OptionCount  int                `json:"optionCount"`
	Duration     int64              `json:"duration"`
	Multiple     bool               `json:"multiple"`
	Anonymous    bool               `json:"anonymous"`
	Intermediate bool               `json:"intermediate"`
	Result       memberMessageInput `json:"result"`
}
type memberPollState struct {
	ID           string     `json:"id"`
	MessageID    int64      `json:"messageId"`
	ClosesAt     int64      `json:"closesAt"`
	ClosedAt     *int64     `json:"closedAt"`
	Multiple     bool       `json:"multiple"`
	Anonymous    bool       `json:"anonymous"`
	Intermediate bool       `json:"intermediate"`
	Counts       []int      `json:"counts"`
	Total        int        `json:"total"`
	Own          []int      `json:"own"`
	Voters       [][]string `json:"voters,omitempty"`
}

func pollHash(input *memberPollCreate) []byte {
	raw, _ := json.Marshal(input)
	hash := sha256.Sum256(raw)
	return hash[:]
}
func (s *membershipStore) checkPollRetryTx(ctx context.Context, tx *sql.Tx, id int64, input *memberPollCreate) error {
	var hash []byte
	err := tx.QueryRowContext(ctx, "SELECT create_hash FROM polls WHERE message_id=?", id).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) && input == nil {
		return nil
	}
	if err != nil {
		return memberError(409, "REQUEST_CONFLICT")
	}
	if input == nil || !bytes.Equal(hash, pollHash(input)) {
		return memberError(409, "REQUEST_CONFLICT")
	}
	return nil
}
func (s *membershipStore) createPollTx(ctx context.Context, tx *sql.Tx, id int64, input memberMessageInput) error {
	p := input.Poll
	if p.OptionCount < 2 || p.OptionCount > 10 || !slices.Contains([]int64{3600, 14400, 28800, 86400, 259200, 604800, 1209600}, p.Duration) || p.Result.Poll != nil || len(input.AttachmentIDs) != 0 || p.Result.RemoveAttachment || len(p.Result.AttachmentIDs) != 0 || p.Result.RequestID == input.RequestID || p.Result.KeyID != input.KeyID {
		return memberError(400, "INVALID_POLL")
	}
	nonce, cipher, err := validateMessageInput(p.Result)
	if err != nil {
		return err
	}
	var conflict int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM messages WHERE request_id=? AND author_device_id=(SELECT author_device_id FROM messages WHERE message_id=?)", p.Result.RequestID, id).Scan(&conflict); err != nil {
		return err
	}
	if conflict > 0 {
		return memberError(409, "REQUEST_CONFLICT")
	}
	var active int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM polls p JOIN messages m ON m.message_id=p.message_id WHERE p.closed_at IS NULL AND m.channel_id=(SELECT channel_id FROM messages WHERE message_id=?)", id).Scan(&active); err != nil {
		return err
	}
	if active >= 100 {
		return memberError(429, "POLL_LIMIT")
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO polls(poll_id,message_id,option_count,multiple,anonymous,intermediate,closes_at,result_request_id,result_nonce,result_ciphertext,create_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)", input.RequestID, id, p.OptionCount, p.Multiple, p.Anonymous, p.Intermediate, s.now().UnixMilli()+p.Duration*1000, p.Result.RequestID, nonce, cipher, pollHash(p))
	return err
}
func (s *membershipStore) finishPollTx(ctx context.Context, tx *sql.Tx, pollID string, closedAt int64) error {
	var id int64
	var closed sql.NullInt64
	if err := tx.QueryRowContext(ctx, "SELECT message_id,closed_at FROM polls WHERE poll_id=?", pollID).Scan(&id, &closed); err != nil {
		return err
	}
	if closed.Valid {
		return nil
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO messages(channel_id,author_profile_id,author_device_id,request_id,sent_at,crypto_context_id,nonce,ciphertext)
 SELECT m.channel_id,m.author_profile_id,m.author_device_id,p.result_request_id,?,m.crypto_context_id,p.result_nonce,p.result_ciphertext FROM polls p JOIN messages m ON m.message_id=p.message_id WHERE p.poll_id=?`, closedAt, pollID)
	if err != nil {
		return err
	}
	resultID, err := result.LastInsertId()
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE polls SET closed_at=?,result_message_id=? WHERE poll_id=? AND closed_at IS NULL", closedAt, resultID, pollID); err != nil {
		return err
	}
	return s.enforceMemberStorageTx(ctx, tx, resultID)
}
func (s *membershipStore) closeExpiredPolls(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT poll_id,closes_at FROM polls WHERE closed_at IS NULL AND closes_at<=? ORDER BY closes_at,poll_id", s.now().UnixMilli())
	if err != nil {
		return err
	}
	type deadline struct {
		id string
		at int64
	}
	var pending []deadline
	for rows.Next() {
		var d deadline
		if err = rows.Scan(&d.id, &d.at); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, d)
	}
	if err = closeMemberRows(rows); err != nil {
		return err
	}
	for _, d := range pending {
		if err = s.finishPollTx(ctx, tx, d.id, d.at); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return err
		}
	}
	return tx.Commit()
}

// runPollClock publishes encrypted, pre-authorized replies without any client online.
func (s *membershipStore) runPollClock(ctx context.Context) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		if err := s.closeExpiredPolls(ctx); err != nil && ctx.Err() == nil {
			log.Print("poll completion failed: ", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
func (s *membershipStore) pollState(ctx context.Context, token, pollID string) (memberPollState, error) {
	result := memberPollState{ID: pollID, Counts: []int{}, Own: []int{}}
	if !validHexID(pollID, 32) {
		return result, memberError(400, "INVALID_POLL")
	}
	if err := s.closeExpiredPolls(ctx); err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return result, err
	}
	if !access.allows("chat.read") {
		return result, memberError(403, "FORBIDDEN")
	}
	var options int
	err = tx.QueryRowContext(ctx, "SELECT message_id,option_count,multiple,anonymous,intermediate,closes_at,closed_at FROM polls WHERE poll_id=?", pollID).Scan(&result.MessageID, &options, &result.Multiple, &result.Anonymous, &result.Intermediate, &result.ClosesAt, &result.ClosedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return result, memberError(404, "POLL_NOT_FOUND")
	}
	if err != nil {
		return result, err
	}
	visible := result.Intermediate || result.ClosedAt != nil
	if visible {
		result.Counts = make([]int, options)
		if !result.Anonymous {
			result.Voters = make([][]string, options)
			for i := range result.Voters {
				result.Voters[i] = []string{}
			}
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT profile_id,choices FROM poll_votes WHERE poll_id=?", pollID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var profile, raw string
		if err = rows.Scan(&profile, &raw); err != nil {
			rows.Close()
			return result, err
		}
		var choices []int
		if err = json.Unmarshal([]byte(raw), &choices); err != nil {
			rows.Close()
			return result, err
		}
		if len(choices) == 0 {
			continue
		}
		result.Total++
		if profile == access.EffectiveProfileID {
			result.Own = choices
		}
		if visible {
			for _, i := range choices {
				if i < 0 || i >= options {
					rows.Close()
					return result, memberError(500, "INVALID_POLL")
				}
				result.Counts[i]++
				if !result.Anonymous {
					result.Voters[i] = append(result.Voters[i], profile)
				}
			}
		}
	}
	if err = closeMemberRows(rows); err != nil {
		return result, err
	}
	return result, tx.Commit()
}
func (s *membershipStore) votePoll(ctx context.Context, token, pollID, requestID string, choices []int) error {
	if !validHexID(pollID, 32) || len(choices) > 10 {
		return memberError(400, "INVALID_POLL")
	}
	sorted := append([]int{}, choices...)
	slices.Sort(sorted)
	if len(slices.Compact(append([]int{}, sorted...))) != len(sorted) {
		return memberError(400, "INVALID_VOTE")
	}
	payload, _ := json.Marshal([]any{pollID, sorted})
	return s.mutate(ctx, token, requestID, "poll.vote", "chat.write", payload, func(tx *sql.Tx, access memberAccess) error {
		var options int
		var multiple bool
		var at int64
		var closed sql.NullInt64
		err := tx.QueryRowContext(ctx, "SELECT option_count,multiple,closes_at,closed_at FROM polls WHERE poll_id=?", pollID).Scan(&options, &multiple, &at, &closed)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(404, "POLL_NOT_FOUND")
		}
		if err != nil {
			return err
		}
		if closed.Valid || at <= s.now().UnixMilli() {
			return memberError(409, "POLL_CLOSED")
		}
		if !multiple && len(sorted) > 1 {
			return memberError(400, "INVALID_VOTE")
		}
		for _, i := range sorted {
			if i < 0 || i >= options {
				return memberError(400, "INVALID_VOTE")
			}
		}
		raw, _ := json.Marshal(sorted)
		if len(sorted) == 0 {
			_, err = tx.ExecContext(ctx, "DELETE FROM poll_votes WHERE poll_id=? AND profile_id=?", pollID, access.EffectiveProfileID)
		} else {
			_, err = tx.ExecContext(ctx, "INSERT INTO poll_votes(poll_id,profile_id,choices,updated_at) VALUES(?,?,?,?) ON CONFLICT(poll_id,profile_id) DO UPDATE SET choices=excluded.choices,updated_at=excluded.updated_at", pollID, access.EffectiveProfileID, string(raw), s.now().UnixMilli())
		}
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE channels SET message_revision=message_revision+1 WHERE channel_id=(SELECT channel_id FROM messages WHERE message_id=(SELECT message_id FROM polls WHERE poll_id=?))", pollID)
		return err
	})
}
func (s *membershipStore) closePoll(ctx context.Context, token, pollID, requestID string) error {
	if !validHexID(pollID, 32) {
		return memberError(400, "INVALID_POLL")
	}
	return s.mutate(ctx, token, requestID, "poll.close", "chat.write", []byte(pollID), func(tx *sql.Tx, access memberAccess) error {
		var author string
		var at int64
		err := tx.QueryRowContext(ctx, "SELECT m.author_profile_id,p.closes_at FROM polls p JOIN messages m ON m.message_id=p.message_id WHERE p.poll_id=?", pollID).Scan(&author, &at)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(404, "POLL_NOT_FOUND")
		}
		if err != nil {
			return err
		}
		root, err := resolvedProfileTx(ctx, tx, author)
		if err != nil {
			return err
		}
		if root != access.EffectiveProfileID {
			return memberError(403, "FORBIDDEN")
		}
		return s.finishPollTx(ctx, tx, pollID, min(at, s.now().UnixMilli()))
	})
}
func (a *membershipAPI) pollState(w http.ResponseWriter, r *http.Request) {
	value, err := a.store.pollState(r.Context(), memberBearer(r), r.PathValue("id"))
	if err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, value)
}
func (a *membershipAPI) pollVote(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Choices   []int  `json:"choices"`
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.votePoll(r.Context(), memberBearer(r), r.PathValue("id"), input.RequestID, input.Choices); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
func (a *membershipAPI) pollClose(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RequestID string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 256, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.closePoll(r.Context(), memberBearer(r), r.PathValue("id"), input.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
