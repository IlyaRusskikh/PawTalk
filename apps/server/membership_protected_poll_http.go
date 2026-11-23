package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"net/http"
	"strconv"

	"pawtalk/server/internal/access"
)

func signProtectedPollResult(ctx context.Context, query access.SessionQuery, channel string, position uint64, result access.PollResult) (string, error) {
	var serverID string
	var seed, public []byte
	if err := query.QueryRowContext(ctx, "SELECT server_id,identity_seed,identity_public_key FROM server_state WHERE id=1").
		Scan(&serverID, &seed, &public); err != nil {
		return "", err
	}
	defer clear(seed)
	if len(seed) != ed25519.SeedSize || len(public) != ed25519.PublicKeySize || publicKeyID(public)[:32] != serverID {
		return "", access.InvalidPolicy
	}
	key := ed25519.NewKeyFromSeed(seed)
	defer clear(key)
	if !bytes.Equal(key[ed25519.SeedSize:], public) {
		return "", access.InvalidPolicy
	}
	fields := []string{"pawtalk-poll-result-v1", serverID, channel, strconv.FormatUint(position, 10),
		strconv.FormatUint(result.Original, 10), result.SourceDigest, strconv.FormatInt(result.ClosedAt, 10), strconv.Itoa(result.Total)}
	for _, count := range result.Counts {
		fields = append(fields, strconv.Itoa(count))
	}
	frame, err := signatureFrame(fields...)
	if err != nil {
		return "", err
	}
	return b64.EncodeToString(ed25519.Sign(key, frame)), nil
}

func resolveImportedPoll(ctx context.Context, query access.SessionQuery, channel string, position uint64) (access.PollDefinition, error) {
	var poll access.PollDefinition
	err := query.QueryRowContext(ctx, `SELECT COALESCE(b.target_profile_id,m.author_profile_id),
		p.poll_id,p.option_count,p.closes_at,p.closed_at,p.multiple,p.anonymous,p.intermediate
		FROM protected_migration_message_positions i
		JOIN messages m ON m.message_id=i.message_id AND m.channel_id=i.channel_id
		JOIN polls p ON p.message_id=m.message_id
		JOIN protected_migration_records r ON r.kind='messages' AND r.source_id=CAST(i.message_id AS TEXT) AND r.channel_id=i.channel_id
		LEFT JOIN profile_bindings b ON b.source_profile_id=m.author_profile_id
		WHERE i.channel_id=? AND i.position=?
		AND NOT EXISTS(SELECT 1 FROM protected_message_deletions d WHERE d.channel_id=i.channel_id AND d.position=i.position)`,
		channel, position).Scan(&poll.Author, &poll.LegacyID, &poll.OptionCount, &poll.ClosesAt, &poll.ClosedAt,
		&poll.Multiple, &poll.Anonymous, &poll.Intermediate)
	return poll, err
}

func (p *protectedRuntime) pollSource() access.ResolvePoll {
	if p.importedProfileNames != nil {
		return resolveImportedPoll
	}
	return nil
}

func (p *protectedRuntime) closePollHTTP(w http.ResponseWriter, r *http.Request) {
	channel, position, err := protectedRevisionScope(r)
	store := p.protectedContentStore()
	if err == nil {
		err = store.ClosePoll(r.Context(), p.resolveSession(memberBearer(r)),
			p.pollSource(), channel, position)
	}
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) pollResultTasksHTTP(w http.ResponseWriter, r *http.Request) {
	var sent bool
	err := p.protectedContentStore().DispatchPollResultTasks(r.Context(), p.resolveSession(memberBearer(r)),
		p.importedProfileNames != nil, func(tasks []access.PollResultTask) error {
			return writeProtectedDelivery(w, &sent, tasks)
		})
	if err != nil && !sent {
		protectedRuntimeFail(w, err)
	}
}

func (p *protectedRuntime) publishPollResultHTTP(w http.ResponseWriter, r *http.Request) {
	channel, position, err := protectedRevisionScope(r)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	var publication access.PollResultPublication
	if _, err := decodeMemberJSON(w, r, 1024, &publication); err != nil {
		memberFail(w, err)
		return
	}
	published := false
	sign := func(ctx context.Context, query access.SessionQuery, channel string, position uint64, result access.PollResult) (string, error) {
		published = true
		return signProtectedPollResult(ctx, query, channel, position, result)
	}
	err = p.protectedContentStore().CommitPollResultTask(r.Context(), p.resolveSession(memberBearer(r)),
		channel, position, p.importedProfileNames != nil, publication, sign)
	if err != nil {
		protectedRuntimeFail(w, err)
		return
	}
	if published {
		p.publishProtectedChat(channel, position)
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}

func (p *protectedRuntime) pollHTTP(w http.ResponseWriter, r *http.Request) {
	channel := r.PathValue("channel")
	position, err := strconv.ParseUint(r.PathValue("position"), 10, 64)
	if err != nil || position == 0 || position >= uint64(migrationMaxSafePosition) || !validHexID(channel, 32) {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	lookup := p.pollSource()
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	resolve := p.resolveSession(memberBearer(r))
	if r.Method == http.MethodGet {
		var sent bool
		err = store.DispatchPoll(r.Context(), resolve, lookup, channel, position, func(state access.PollState) error {
			for _, voters := range state.Voters {
				for index := range voters {
					voters[index].Name = p.importedProfileNames[voters[index].ID]
				}
			}
			return writeProtectedDelivery(w, &sent, state)
		})
		if err != nil && !sent {
			protectedRuntimeFail(w, err)
		}
		return
	}
	var input struct {
		OperationID string `json:"operationId"`
		Choices     []int  `json:"choices"`
	}
	if _, err := decodeMemberJSON(w, r, 512, &input); err != nil {
		memberFail(w, err)
		return
	}
	if input.Choices == nil {
		protectedRuntimeFail(w, access.InvalidAction)
		return
	}
	if err := store.VotePoll(r.Context(), resolve, lookup, channel, position, input.OperationID, input.Choices); err != nil {
		if errors.Is(err, access.ErrPollClosed) {
			err = memberError(http.StatusConflict, "POLL_CLOSED")
		}
		protectedRuntimeFail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]bool{"ok": true})
}
