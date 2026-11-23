package access

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"strconv"
	"strings"
)

func EnsureMessageReplySchema(ctx context.Context, tx *sql.Tx) error {
	_, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS protected_message_replies (
		channel_id TEXT NOT NULL, reply_position INTEGER NOT NULL,
		position INTEGER NOT NULL CHECK(position>0 AND position<reply_position),
		digest TEXT NOT NULL, salt TEXT NOT NULL,
		PRIMARY KEY(channel_id,reply_position)
	) STRICT`)
	return err
}

type MessageReply struct {
	Position uint64
	Salt     string
}

func validMessageReply(attempt MessageAttempt) bool {
	if attempt.Reply == nil {
		return attempt.ReplyDigest == ""
	}
	reply := attempt.Reply
	if reply.Position == 0 || len(reply.Salt) != 64 || strings.Trim(reply.Salt, "0123456789abcdef") != "" {
		return false
	}
	digest := sha256.Sum256([]byte("pawtalk-protected-reply-v1:" + attempt.OperationID +
		":" + strconv.FormatUint(reply.Position, 10) + ":" + reply.Salt))
	return attempt.ReplyDigest == hex.EncodeToString(digest[:])
}

func insertMessageReply(ctx context.Context, tx *sql.Tx, state State, principal Principal, attempt MessageAttempt,
	position uint64, hasImported bool) error {
	if attempt.Reply == nil {
		return nil
	}
	original := attempt.Reply.Position
	if original >= position || !state.CanDeliver(principal.ProfileID, attempt.ChannelID, original) {
		return ChannelRestricted
	}
	retained, err := canReadRetainedMessage(ctx, tx, attempt.ChannelID, original,
		state.firstReadablePosition(attempt.ChannelID, principal.ProfileID), hasImported)
	if err != nil {
		return err
	}
	if !retained {
		return ChannelRestricted
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO protected_message_replies(channel_id,reply_position,position,digest,salt)
		VALUES(?,?,?,?,?)`, attempt.ChannelID, position, original, attempt.ReplyDigest, attempt.Reply.Salt)
	return err
}
