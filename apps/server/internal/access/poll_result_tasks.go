package access

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
)

const pollResultTaskLimit = 4

type PollResultTask struct {
	ChannelID    string `json:"channelId"`
	Original     uint64 `json:"originalPosition"`
	SourceDigest string `json:"originalDigest"`
	ClosedAt     int64  `json:"closedAt"`
	Counts       []int  `json:"counts"`
	Total        int    `json:"total"`
	PolicyDigest string `json:"policyDigest"`
	Generation   uint64 `json:"generation"`
	KeyID        string `json:"keyId"`
}

type PollResultPublication struct {
	SourceDigest string `json:"originalDigest"`
	PolicyDigest string `json:"policyDigest"`
	Generation   uint64 `json:"generation"`
	KeyID        string `json:"keyId"`
	Signature    []byte `json:"signature"`
}

type pollResultAudience struct {
	First      uint64 `json:"first"`
	Generation uint64 `json:"generation"`
}

const pollResultAudienceFilter = ` WHERE EXISTS (
	SELECT 1 FROM json_each(?) audience
	JOIN protected_epoch_packages p ON p.channel_id=audience.key AND p.purpose='live'
		AND p.generation=json_extract(audience.value,'$.generation') AND p.recipient_id=? AND p.recipient_key=?
	WHERE audience.key=pending.channel_id AND pending.position>=json_extract(audience.value,'$.first')
	AND NOT EXISTS (SELECT 1 FROM protected_rotation_tasks t WHERE t.channel_id=p.channel_id AND t.purpose='live')
)`

func (s *Store) DispatchPollResultTasks(ctx context.Context, resolve ResolveSession, hasImported bool, deliver func([]PollResultTask) error) error {
	return s.dispatchAuthorized(ctx, resolve, func(conn *sql.Conn, state State, actor Principal) error {
		tasks := make([]PollResultTask, 0, pollResultTaskLimit)
		if !state.PolicyAnchored || !state.hasPolicyDevice(actor) {
			return InvalidAction
		}
		audience := make(map[string]pollResultAudience)
		for id := range state.Channels {
			if generation := state.currentGeneration(id, LiveEpoch); generation != 0 && state.canLoadEpoch(actor, id, LiveEpoch) {
				audience[id] = pollResultAudience{First: state.firstReadablePosition(id, actor.ProfileID), Generation: generation}
			}
		}
		if len(audience) == 0 {
			return deliver(tasks)
		}
		eligible, err := json.Marshal(audience)
		if err != nil {
			return err
		}
		batch, err := readPendingPollResults(ctx, conn, hasImported, pollResultAudienceFilter,
			[]any{string(eligible), actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey}, pollResultTaskLimit)
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			return deliver(tasks)
		}
		digest, err := state.PolicyDigest()
		if err != nil {
			return err
		}
		for _, item := range batch {
			task, err := currentPollResultTask(ctx, conn, item, audience[item.channel].Generation, digest)
			if err != nil {
				return err
			}
			tasks = append(tasks, task)
		}
		return deliver(tasks)
	})
}

func currentPollResultTask(ctx context.Context, query SessionQuery, item frozenPollResult, generation uint64, policyDigest string) (PollResultTask, error) {
	task := PollResultTask{ChannelID: item.channel, Original: item.Original, SourceDigest: item.SourceDigest,
		ClosedAt: item.ClosedAt, Counts: item.Counts, Total: item.Total, PolicyDigest: policyDigest, Generation: generation}
	err := query.QueryRowContext(ctx, `SELECT key_id FROM protected_epochs WHERE channel_id=? AND purpose='live' AND generation=?`,
		task.ChannelID, task.Generation).Scan(&task.KeyID)
	return task, err
}

func PollResultPublicationFrame(serverID string, actor Principal, task PollResultTask) ([]byte, error) {
	fields := []string{"pawtalk-poll-result-publication-v1", serverID, task.ChannelID, strconv.FormatUint(task.Original, 10),
		task.SourceDigest, actor.ProfileID, actor.DeviceID, task.PolicyDigest, strconv.FormatUint(task.Generation, 10), task.KeyID,
		strconv.FormatInt(task.ClosedAt, 10), strconv.Itoa(task.Total)}
	for _, count := range task.Counts {
		fields = append(fields, strconv.Itoa(count))
	}
	return SignatureFrame(fields...)
}

func (s *Store) CommitPollResultTask(ctx context.Context, resolve ResolveSession, channel string, position uint64, hasImported bool,
	request PollResultPublication, sign SignPollResult) error {
	if !validRotationID(channel) || position == 0 || request.Generation == 0 || !isDigest(request.KeyID) ||
		!isDigest(request.SourceDigest) || !isDigest(request.PolicyDigest) || len(request.Signature) != ed25519.SignatureSize {
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
	if !state.PolicyAnchored || !state.hasPolicyDevice(actor) || !state.canLoadEpoch(actor, channel, LiveEpoch) ||
		position < state.firstReadablePosition(channel, actor.ProfileID) {
		return ChannelRestricted
	}
	first := state.firstReadablePosition(channel, actor.ProfileID)
	retained, err := canReadRetainedMessage(ctx, tx, channel, position, first, hasImported)
	if err != nil {
		return err
	}
	if !retained {
		return ChannelRestricted
	}
	receiptFrame, err := SignatureFrame("pawtalk-poll-result-publication-receipt-v1", channel, strconv.FormatUint(position, 10),
		actor.ProfileID, actor.DeviceID, request.SourceDigest, request.PolicyDigest, strconv.FormatUint(request.Generation, 10),
		request.KeyID, base64.StdEncoding.EncodeToString(request.Signature))
	if err != nil {
		return err
	}
	publicationDigest := hexHash(receiptFrame)
	var existing sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT json_extract(record,'$.publicationDigest') FROM protected_poll_results
		WHERE channel_id=? AND original_position=?`, channel, position).Scan(&existing)
	if err == nil {
		if !existing.Valid || existing.String != publicationDigest {
			return ErrRotationUnavailable
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	digest, err := state.PolicyDigest()
	if err != nil {
		return err
	}
	if digest != request.PolicyDigest || state.currentGeneration(channel, LiveEpoch) != request.Generation {
		return ErrPolicyConflict
	}
	scope, err := json.Marshal(map[string]pollResultAudience{
		channel: {First: first, Generation: request.Generation},
	})
	if err != nil {
		return err
	}
	batch, err := readPendingPollResults(ctx, tx, hasImported, pollResultAudienceFilter+" AND pending.position=?",
		[]any{string(scope), actor.DeviceID, state.KeyRecipients[actor.DeviceID].PublicKey, position}, 1)
	if err != nil {
		return err
	}
	if len(batch) != 1 {
		return ErrRotationUnavailable
	}
	task, err := currentPollResultTask(ctx, tx, batch[0], request.Generation, digest)
	if err != nil {
		return err
	}
	if task.SourceDigest != request.SourceDigest || task.KeyID != request.KeyID {
		return ErrPolicyConflict
	}
	var serverID string
	if err := tx.QueryRowContext(ctx, "SELECT server_id FROM server_state WHERE id=1").Scan(&serverID); err != nil {
		return err
	}
	public, err := hex.DecodeString(state.PolicyDevices[actor.DeviceID].PublicKey)
	if err != nil || len(public) != ed25519.PublicKeySize || hexHash(public) != actor.DeviceID {
		return InvalidPolicy
	}
	frame, err := PollResultPublicationFrame(serverID, actor, task)
	if err != nil || !ed25519.Verify(public, frame, request.Signature) {
		return ErrPolicySignatureRequired
	}
	batch[0].publicationDigest = publicationDigest
	return s.commitFrozenPollResults(ctx, tx, state, batch, sign)
}
