package access

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strings"
)

var ErrMessageConflict = errors.New("protected message operation conflict")
var ErrNonceReuse = errors.New("protected message nonce reuse")
var ErrMessageRateLimit = errors.New("protected message rate limit")
var ErrDeferredAdmissionChanged = errors.New("protected deferred send admission changed")

// DeferredAdmission identifies the policy at which the user requested the send.
// This write precondition is transport metadata, outside the encrypted packet.
type DeferredAdmission struct {
	Revision int64
	Head     string
}

type SlowmodeWait struct{ RetryAt int64 }

func (SlowmodeWait) Error() string { return "protected channel slowmode" }

type MessageAttempt struct {
	ChannelID      string
	OperationID    string
	KeyID          string
	Nonce          []byte
	Ciphertext     []byte
	Signature      []byte
	ReplyDigest    string              `json:",omitempty"`
	Reply          *MessageReply       `json:",omitempty"`
	Checklist      *MessageChecklist   `json:",omitempty"`
	Poll           *MessagePoll        `json:",omitempty"`
	Attachments    []MessageAttachment `json:",omitempty"`
	MentionDigest  string              `json:",omitempty"`
	MentionRouting *MentionRouting     `json:",omitempty"`
	Deferred       *DeferredAdmission  `json:"-"`
}

// VerifyMessageAttempt checks the current key generation and the device's
// signature against the verified policy. It runs before a new write.
type VerifyMessageAttempt func(context.Context, SessionQuery, Principal, int64, MessageAttempt) error

type MessageReceipt struct {
	Position uint64
	Existing bool
}

type LiveMessage struct {
	Position                uint64
	Generation              uint64
	Author                  Principal
	SentAt                  int64
	Packet                  MessageAttempt
	Revision                uint64                       `json:",omitempty"`
	PollClosed              bool                         `json:",omitempty"`
	PollResult              *PollResult                  `json:",omitempty"`
	AuthorPolicy            *TextChannelPolicyDisclosure `json:",omitempty"`
	PreviousAuthorPolicy    *TextChannelPolicyDisclosure `json:"previousAuthorPolicy,omitempty"`
	RoleAssignmentAuthorKey *profileSigningKeyOpening    `json:"roleAssignmentAuthorKey,omitempty"`
}

type LiveMessagePage struct {
	First    uint64        `json:"first"`
	Messages []LiveMessage `json:"messages"`
	Next     uint64        `json:"next,omitempty"`
}

type LiveMessageDelivery struct {
	Window HistoryWindow   `json:"window"`
	Page   LiveMessagePage `json:"page"`
}

// DispatchLiveMessageDelivery checks current history access and writes under the
// same policy lock as HTTP. The notification position is only a lookup hint.
func (s *Store) DispatchLiveMessageDelivery(ctx context.Context, resolve ResolveSession, channel string, position uint64,
	scoped *TextChannelPolicyProofCache, hasImported bool, verify VerifyEpochRecord, deliver func(LiveMessageDelivery) error) error {
	if position == 0 || position >= math.MaxInt64 {
		return InvalidAction
	}
	return s.dispatchHistory(ctx, resolve, channel, func(conn *sql.Conn, state State, actor Principal, first, next uint64) error {
		if position < first || position >= next {
			return nil
		}
		now := s.now().UnixMilli()
		page, err := readLiveMessagePage(ctx, conn, channel, first, position, position+1, 1, hasImported, now)
		if err != nil || len(page.Messages) != 1 {
			return err
		}
		if page.Messages[0].Revision != 0 {
			return nil
		}
		if err := addLiveMessageAuthorEvidence(ctx, conn, channel, scoped, page.Messages, verify); err != nil {
			return err
		}
		page.First = first
		return readHistoryWindow(ctx, conn, state, actor, channel, first, next, nil, hasImported, now, func(window HistoryWindow) error {
			window.Last = position
			return deliver(LiveMessageDelivery{Window: window, Page: page})
		})
	})
}

func (s *Store) DispatchLiveMessages(ctx context.Context, resolve ResolveSession, channel string, after uint64, limit int,
	scoped *TextChannelPolicyProofCache, hasImported bool, deliver func(LiveMessagePage) error, epochVerifiers ...VerifyEpochRecord) error {
	if after >= math.MaxInt64 || limit < 1 || limit > 32 {
		return InvalidAction
	}
	return s.DispatchHistory(ctx, resolve, channel, func(conn *sql.Conn, first, next uint64) error {
		page := LiveMessagePage{Messages: make([]LiveMessage, 0, limit)}
		start := max(first, after+1)
		if start < next {
			var err error
			page, err = readLiveMessagePage(ctx, conn, channel, first, start, next, limit+1, hasImported, s.now().UnixMilli())
			if err != nil {
				return err
			}
			results, err := readPublishedPollResults(ctx, conn, channel, first, start, next, limit+1)
			if err != nil {
				return err
			}
			more := page.Next != 0 || len(page.Messages)+len(results) > limit
			page.Messages = append(page.Messages, results...)
			slices.SortFunc(page.Messages, func(a, b LiveMessage) int { return cmp.Compare(a.Position, b.Position) })
			if more {
				page.Messages = page.Messages[:limit]
				page.Next = page.Messages[limit-1].Position
			}
		}
		if scoped != nil {
			var verify VerifyEpochRecord
			if len(epochVerifiers) == 1 {
				verify = epochVerifiers[0]
			}
			if err := addLiveMessageAuthorEvidence(ctx, conn, channel, scoped, page.Messages, verify); err != nil {
				return err
			}
		}
		page.First = first
		if err := ctx.Err(); err != nil {
			return err
		}
		return deliver(page)
	})
}

func readLiveMessagePage(ctx context.Context, conn *sql.Conn, channel string, first, start, next uint64, limit int, hasImported bool, now int64) (LiveMessagePage, error) {
	page := LiveMessagePage{Messages: make([]LiveMessage, 0, limit)}
	args := []any{now, first, first}
	if hasImported {
		args = append(args, first)
	}
	rows, err := conn.QueryContext(ctx, `SELECT m.position,e.generation,m.device_id,m.profile_id,r.sent_at,m.operation_id,m.key_id,m.nonce,m.ciphertext,m.signature,
		COALESCE((SELECT MAX(x.revision) FROM protected_text_revisions x WHERE x.channel_id=m.channel_id AND x.position=m.position),0),
		COALESCE(reply.digest,''),COALESCE(p.position,0),COALESCE(p.salt,''),c.definition,poll.definition,
		COALESCE(poll.closed_at IS NOT NULL OR poll.closes_at<=?,0) OR closure.closed_at IS NOT NULL, COALESCE(mention.digest,''),
		(SELECT json_group_array(json_object('id',id,'kind',kind)) FROM
			(SELECT id,kind FROM protected_attachments a WHERE a.channel_id=m.channel_id AND a.position=m.position ORDER BY ordinal))
		FROM protected_messages m JOIN protected_message_receipts r ON r.device_id=m.device_id AND r.operation_id=m.operation_id
		AND r.channel_id=m.channel_id AND r.position=m.position AND r.profile_id=m.profile_id
		LEFT JOIN protected_epochs e ON e.channel_id=m.channel_id AND e.purpose='live' AND e.key_id=m.key_id
		LEFT JOIN protected_checklists c ON c.channel_id=m.channel_id AND c.position=m.position
		LEFT JOIN protected_polls poll ON poll.channel_id=m.channel_id AND poll.position=m.position
		LEFT JOIN protected_poll_closures closure ON closure.channel_id=m.channel_id AND closure.position=m.position
		LEFT JOIN protected_message_replies reply ON reply.channel_id=m.channel_id AND reply.reply_position=m.position
		LEFT JOIN protected_message_mentions mention ON mention.channel_id=m.channel_id AND mention.position=m.position
		LEFT JOIN protected_message_replies p ON p.channel_id=reply.channel_id AND p.reply_position=reply.reply_position
			AND p.position>=? AND `+retainedMessageOriginal(hasImported)+`
		WHERE m.channel_id=? AND m.position>=? AND m.position<? ORDER BY m.position LIMIT ?`, append(args, channel, start, next, limit+1)...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		if len(page.Messages) == limit {
			page.Next = page.Messages[limit-1].Position
			break
		}
		message := LiveMessage{Packet: MessageAttempt{ChannelID: channel}}
		var reply MessageReply
		var checklist, poll sql.NullString
		var attachments []byte
		if err := rows.Scan(&message.Position, &message.Generation, &message.Author.DeviceID, &message.Author.ProfileID, &message.SentAt,
			&message.Packet.OperationID, &message.Packet.KeyID, &message.Packet.Nonce, &message.Packet.Ciphertext, &message.Packet.Signature,
			&message.Revision, &message.Packet.ReplyDigest, &reply.Position, &reply.Salt, &checklist, &poll, &message.PollClosed,
			&message.Packet.MentionDigest, &attachments); err != nil {
			return LiveMessagePage{}, err
		}
		if err := json.Unmarshal(attachments, &message.Packet.Attachments); err != nil {
			return LiveMessagePage{}, err
		}
		if poll.Valid {
			if err := json.Unmarshal([]byte(poll.String), &message.Packet.Poll); err != nil {
				return LiveMessagePage{}, err
			}
		}
		if reply.Position != 0 {
			message.Packet.Reply = &reply
		}
		if checklist.Valid {
			if err := json.Unmarshal([]byte(checklist.String), &message.Packet.Checklist); err != nil {
				return LiveMessagePage{}, err
			}
		}
		page.Messages = append(page.Messages, message)
	}
	return page, rows.Err()
}

func (s *Store) AppendMessage(ctx context.Context, resolve ResolveSession, verify VerifyMessageAttempt, attempt MessageAttempt, hasImported bool) (MessageReceipt, error) {
	if verify == nil || len(attempt.OperationID) != 32 || strings.Trim(attempt.OperationID, "0123456789abcdef") != "" ||
		len(attempt.KeyID) != 64 || strings.Trim(attempt.KeyID, "0123456789abcdef") != "" ||
		len(attempt.Nonce) != 12 || len(attempt.Ciphertext) < 17 || len(attempt.Ciphertext) > 12304 || len(attempt.Signature) != 64 ||
		!validMessageReply(attempt) || !attempt.Checklist.valid() || !attempt.Poll.valid() || !validMessageAttachments(attempt.Attachments) ||
		!attempt.MentionRouting.matchesDigest(attempt.MentionDigest) ||
		attempt.Poll != nil && (attempt.Checklist != nil || attempt.Reply != nil) {
		return MessageReceipt{}, InvalidAction
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MessageReceipt{}, err
	}
	defer tx.Rollback()
	principal, err := resolve(ctx, tx)
	if err != nil {
		return MessageReceipt{}, err
	}
	state, revision, err := readState(tx.QueryRowContext(ctx, "SELECT revision,snapshot FROM protected_policy WHERE id=1"))
	if err != nil {
		return MessageReceipt{}, err
	}
	channel, exists := state.Channels[attempt.ChannelID]
	if !exists || !state.canUseDevice(principal) || !state.CanDeliver(principal.ProfileID, attempt.ChannelID, 0) {
		return MessageReceipt{}, ChannelRestricted
	}
	if attempt.Deferred != nil {
		if err := checkDeferredAdmission(ctx, tx, state.PolicyAnchored, revision, principal.ProfileID, attempt.ChannelID, *attempt.Deferred); err != nil {
			return MessageReceipt{}, err
		}
	}
	var existing MessageReceipt
	var channelID, profileID string
	err = tx.QueryRowContext(ctx, `SELECT channel_id, profile_id, position FROM protected_message_receipts
	    WHERE device_id=? AND operation_id=?`, principal.DeviceID, attempt.OperationID).Scan(&channelID, &profileID, &existing.Position)
	if err == nil {
		if channelID != attempt.ChannelID || profileID != principal.ProfileID ||
			!state.CanDeliver(principal.ProfileID, channelID, existing.Position) {
			return MessageReceipt{}, ErrMessageConflict
		}
		existing.Existing = true
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return MessageReceipt{}, err
	}
	now := s.now().UnixMilli()
	actor := state.Members[principal.ProfileID]
	timeout, err := readTimeout(ctx, tx, actor)
	if err != nil {
		return MessageReceipt{}, err
	}
	actor.TimeoutUntil = timeout.Deadline
	scope := state.scope(channel)
	if allowed := state.CheckGrant(actor, scope, "message.send", now); allowed != Allowed {
		return MessageReceipt{}, allowed
	}
	if allowed := state.checkMessageMentions(actor, scope, attempt.ChannelID, now, attempt.MentionRouting); allowed != Allowed {
		return MessageReceipt{}, allowed
	}
	for _, ref := range attempt.Attachments {
		if allowed := state.CheckGrant(actor, scope, ref.grant(), now); allowed != Allowed {
			return MessageReceipt{}, allowed
		}
	}
	if attempt.Checklist != nil {
		if allowed := state.CheckGrant(actor, scope, "checklist.create", now); allowed != Allowed {
			return MessageReceipt{}, allowed
		}
	}
	if attempt.Poll != nil {
		if allowed := state.CheckGrant(actor, scope, "poll.create", now); allowed != Allowed {
			return MessageReceipt{}, allowed
		}
	}
	if err := state.checkMessageDelay(ctx, tx, principal, attempt.ChannelID, channel, now); err != nil {
		return MessageReceipt{}, err
	}
	if err := verify(ctx, tx, principal, now, attempt); err != nil {
		return MessageReceipt{}, err
	}
	position := channel.NextPosition
	if position >= math.MaxInt64 {
		return MessageReceipt{}, InvalidPolicy
	}
	if err := insertMessageReply(ctx, tx, state, principal, attempt, position, hasImported); err != nil {
		return MessageReceipt{}, err
	}
	if err := insertMessageChecklist(ctx, tx, attempt, position); err != nil {
		return MessageReceipt{}, err
	}
	if err := insertMessagePoll(ctx, tx, attempt, principal, position, now); err != nil {
		return MessageReceipt{}, err
	}
	if err := bindMessageAttachments(ctx, tx, attempt, principal, position, now); err != nil {
		return MessageReceipt{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO protected_message_receipts
	    (channel_id,position,device_id,profile_id,operation_id,key_id,sent_at,nonce)
	    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(key_id,nonce) DO NOTHING`,
		attempt.ChannelID, position, principal.DeviceID, principal.ProfileID, attempt.OperationID,
		attempt.KeyID, now, attempt.Nonce)
	if err != nil {
		return MessageReceipt{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return MessageReceipt{}, err
	}
	if count == 0 {
		return MessageReceipt{}, ErrNonceReuse
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO protected_messages
	    (channel_id,position,device_id,profile_id,operation_id,key_id,nonce,ciphertext,signature)
	    VALUES(?,?,?,?,?,?,?,?,?)`, attempt.ChannelID, position, principal.DeviceID,
		principal.ProfileID, attempt.OperationID, attempt.KeyID, attempt.Nonce, attempt.Ciphertext, attempt.Signature); err != nil {
		return MessageReceipt{}, err
	}
	if err := insertMessageMentions(ctx, tx, state, principal, attempt, position, now); err != nil {
		return MessageReceipt{}, err
	}
	channel.NextPosition++
	state.Channels[attempt.ChannelID] = channel
	snapshot, err := json.Marshal(state)
	if err != nil {
		return MessageReceipt{}, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE protected_policy SET snapshot=? WHERE id=1", snapshot); err != nil {
		return MessageReceipt{}, err
	}
	if err := s.enforceStorageRetention(ctx, tx, storagePosition{attempt.ChannelID, position}); err != nil {
		return MessageReceipt{}, err
	}
	if err = tx.Commit(); err != nil {
		return MessageReceipt{}, err
	}
	return MessageReceipt{Position: position}, nil
}

func (s State) checkMessageDelay(ctx context.Context, tx *sql.Tx, principal Principal, channelID string, channel Channel, now int64) error {
	var recent int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM protected_message_receipts WHERE device_id=? AND sent_at>?",
		principal.DeviceID, now-1000).Scan(&recent); err != nil {
		return err
	}
	if recent >= 5 {
		return ErrMessageRateLimit
	}
	if channel.Settings == nil || channel.Settings.SlowmodeSeconds == 0 ||
		s.CheckGrant(s.Members[principal.ProfileID], s.scope(channel), "message.slowmode.bypass", now) == Allowed {
		return nil
	}
	var last sql.NullInt64
	if err := tx.QueryRowContext(ctx, "SELECT MAX(sent_at) FROM protected_message_receipts WHERE channel_id=? AND profile_id=?",
		channelID, principal.ProfileID).Scan(&last); err != nil {
		return err
	}
	retryAt := last.Int64 + int64(channel.Settings.SlowmodeSeconds)*1000
	if last.Valid && now < retryAt {
		return SlowmodeWait{RetryAt: retryAt}
	}
	return nil
}
