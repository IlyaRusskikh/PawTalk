package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type memberMessageInput struct {
	RemoveAttachment bool     `json:"removeAttachment,omitempty"`
	RequestID        string   `json:"requestId"`
	KeyID            string   `json:"keyId"`
	Nonce            string   `json:"nonce"`
	Ciphertext       string   `json:"ciphertext"`
	AttachmentIDs    []string `json:"attachmentIds"`
}
type memberMessage struct {
	ID              int64    `json:"id"`
	ChannelID       string   `json:"channelId"`
	AuthorProfileID string   `json:"authorProfileId"`
	AuthorDeviceID  string   `json:"authorDeviceId"`
	RequestID       string   `json:"requestId"`
	SentAt          int64    `json:"sentAt"`
	EditedAt        *int64   `json:"editedAt"`
	KeyID           string   `json:"keyId"`
	Nonce           string   `json:"nonce"`
	Ciphertext      string   `json:"ciphertext"`
	AttachmentIDs   []string `json:"attachmentIds"`
}
type memberMessagePage struct {
	Messages []memberMessage `json:"messages"`
	First    int64           `json:"first"`
	Last     int64           `json:"last"`
	HasOlder bool            `json:"hasOlder"`
	HasNewer bool            `json:"hasNewer"`
	Unread   int64           `json:"unread"`
}

func validateMessageInput(input memberMessageInput) ([]byte, []byte, error) {
	if !validHexID(input.RequestID, 32) || !validHexID(input.KeyID, 64) || len(input.AttachmentIDs) > 1 {
		return nil, nil, memberError(400, "INVALID_MESSAGE")
	}
	nonce, err := decodeFixed(input.Nonce, 12)
	if err != nil {
		return nil, nil, memberError(400, "INVALID_MESSAGE")
	}
	cipher, err := b64.Strict().DecodeString(input.Ciphertext)
	if err != nil || len(cipher) < 17 || len(cipher) > 12304 || b64.EncodeToString(cipher) != input.Ciphertext {
		return nil, nil, memberError(400, "INVALID_MESSAGE")
	}
	for _, id := range input.AttachmentIDs {
		if !validHexID(id, 32) {
			return nil, nil, memberError(400, "INVALID_ATTACHMENT")
		}
	}
	return nonce, cipher, nil
}

func memberTextChannelTx(ctx context.Context, tx *sql.Tx, channel string) error {
	var kind string
	err := tx.QueryRowContext(ctx, "SELECT kind FROM channels WHERE channel_id=?", channel).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return memberError(404, "CHANNEL_NOT_FOUND")
	}
	if err != nil {
		return err
	}
	if kind != "text" {
		return memberError(400, "TEXT_CHANNEL_REQUIRED")
	}
	return nil
}

func (s *membershipStore) postMessage(ctx context.Context, token, channel string, input memberMessageInput) (int64, error) {
	if !validHexID(channel, 32) {
		return 0, memberError(400, "INVALID_CHANNEL")
	}
	nonce, cipher, err := validateMessageInput(input)
	if err != nil {
		return 0, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return 0, err
	}
	if !access.allows("chat.write") {
		return 0, memberError(403, "FORBIDDEN")
	}
	if err = memberTextChannelTx(ctx, tx, channel); err != nil {
		return 0, err
	}
	var keyID string
	if err = tx.QueryRowContext(ctx, "SELECT e2ee_key_id FROM server_state WHERE id=1").Scan(&keyID); err != nil {
		return 0, err
	}
	if keyID != input.KeyID {
		return 0, memberError(409, "KEY_ID_MISMATCH")
	}
	var id int64
	var oldChannel string
	var oldNonce, oldCipher []byte
	err = tx.QueryRowContext(ctx, "SELECT message_id,channel_id,nonce,ciphertext FROM messages WHERE author_device_id=? AND request_id=?", access.DeviceID, input.RequestID).Scan(&id, &oldChannel, &oldNonce, &oldCipher)
	if err == nil {
		if oldChannel != channel || !bytes.Equal(oldNonce, nonce) || !bytes.Equal(oldCipher, cipher) {
			return 0, memberError(409, "REQUEST_CONFLICT")
		}
		var attachments []string
		rows, err := tx.QueryContext(ctx, "SELECT attachment_id FROM attachments WHERE message_id=? ORDER BY attachment_id", id)
		if err != nil {
			return 0, err
		}
		for rows.Next() {
			var a string
			if err = rows.Scan(&a); err != nil {
				rows.Close()
				return 0, err
			}
			attachments = append(attachments, a)
		}
		if err = closeMemberRows(rows); err != nil {
			return 0, err
		}
		if len(attachments) != len(input.AttachmentIDs) || (len(attachments) == 1 && attachments[0] != input.AttachmentIDs[0]) {
			return 0, memberError(409, "REQUEST_CONFLICT")
		}
		return id, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var recent int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM messages WHERE author_device_id=? AND sent_at>?", access.DeviceID, s.now().UnixMilli()-1000).Scan(&recent); err != nil {
		return 0, err
	}
	if recent >= 5 {
		return 0, memberError(429, "MESSAGE_RATE_LIMIT")
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO messages(channel_id,author_profile_id,author_device_id,request_id,sent_at,crypto_context_id,nonce,ciphertext) VALUES(?,?,?,?,?,?,?,?)", channel, access.ProfileID, access.DeviceID, input.RequestID, s.now().UnixMilli(), input.KeyID, nonce, cipher)
	if err != nil {
		return 0, err
	}
	id, err = result.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, attachment := range input.AttachmentIDs {
		result, err = tx.ExecContext(ctx, "UPDATE attachments SET message_id=? WHERE attachment_id=? AND channel_id=? AND owner_device_id=? AND message_id IS NULL", id, attachment, channel, access.DeviceID)
		if err != nil {
			return 0, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		if count != 1 {
			return 0, memberError(403, "ATTACHMENT_NOT_OWNED")
		}
	}
	if err = s.enforceMemberStorageTx(ctx, tx, id); err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

func (s *membershipStore) editMessage(ctx context.Context, token string, id int64, input memberMessageInput) error {
	if id < 1 || len(input.AttachmentIDs) != 0 {
		return memberError(400, "INVALID_MESSAGE")
	}
	nonce, cipher, err := validateMessageInput(input)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal([]any{id, input})
	return s.mutate(ctx, token, input.RequestID, "message.edit", "chat.write", payload, func(tx *sql.Tx, access memberAccess) error {
		var original, keyID string
		err := tx.QueryRowContext(ctx, "SELECT author_profile_id,crypto_context_id FROM messages WHERE message_id=?", id).Scan(&original, &keyID)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(404, "MESSAGE_NOT_FOUND")
		}
		if err != nil {
			return err
		}
		root, err := resolvedProfileTx(ctx, tx, original)
		if err != nil {
			return err
		}
		if root != access.EffectiveProfileID {
			return memberError(403, "MESSAGE_NOT_OWNED")
		}
		if keyID != input.KeyID {
			return memberError(409, "KEY_ID_MISMATCH")
		}
		if _, err = tx.ExecContext(ctx, "UPDATE messages SET nonce=?,ciphertext=?,edited_at=? WHERE message_id=?", nonce, cipher, s.now().UnixMilli(), id); err != nil {
			return err
		}
		if input.RemoveAttachment {
			if _, err = tx.ExecContext(ctx, "DELETE FROM attachments WHERE message_id=?", id); err != nil {
				return err
			}
		}
		return s.enforceMemberStorageTx(ctx, tx, id)
	})
}

func (s *membershipStore) deleteMessage(ctx context.Context, token string, id int64, requestID string) error {
	if id < 1 {
		return memberError(400, "INVALID_MESSAGE")
	}
	payload, _ := json.Marshal(id)
	return s.mutate(ctx, token, requestID, "message.delete", "chat.write", payload, func(tx *sql.Tx, access memberAccess) error {
		var original string
		err := tx.QueryRowContext(ctx, "SELECT author_profile_id FROM messages WHERE message_id=?", id).Scan(&original)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(404, "MESSAGE_NOT_FOUND")
		}
		if err != nil {
			return err
		}
		root, err := resolvedProfileTx(ctx, tx, original)
		if err != nil {
			return err
		}
		if root != access.EffectiveProfileID {
			return memberError(403, "MESSAGE_NOT_OWNED")
		}
		_, err = tx.ExecContext(ctx, "DELETE FROM messages WHERE message_id=?", id)
		return err
	})
}

func (s *membershipStore) enforceMemberStorageTx(ctx context.Context, tx *sql.Tx, protected int64) error {
	if s.maxBytes == 0 {
		return nil
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
		var oldest int64
		err := tx.QueryRowContext(ctx, "SELECT message_id FROM messages WHERE message_id<>? ORDER BY message_id LIMIT 1", protected).Scan(&oldest)
		if errors.Is(err, sql.ErrNoRows) {
			return memberError(507, "STORAGE_LIMIT")
		}
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM messages WHERE message_id=?", oldest); err != nil {
			return err
		}
	}
}
