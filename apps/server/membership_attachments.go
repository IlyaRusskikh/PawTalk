package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
)

func (s *membershipStore) putAttachment(ctx context.Context, token, channel, id string, packet memberInvitePackage) error {
	if !validHexID(channel, 32) || !validHexID(id, 32) || packet.Version != 2 || !validHexID(packet.KeyID, 64) {
		return memberError(400, "INVALID_ATTACHMENT")
	}
	nonce, err := decodeFixed(packet.Nonce, 12)
	if err != nil {
		return memberError(400, "INVALID_ATTACHMENT")
	}
	cipher, err := b64.Strict().DecodeString(packet.Ciphertext)
	if err != nil || len(cipher) < 17 || len(cipher) > 2097168 || b64.EncodeToString(cipher) != packet.Ciphertext {
		return memberError(413, "ATTACHMENT_TOO_LARGE")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	defer s.dropDeliveries(tx)
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return err
	}
	if !access.allows("chat.write") {
		return memberError(403, "FORBIDDEN")
	}
	if err = memberTextChannelTx(ctx, tx, channel); err != nil {
		return err
	}
	var configured string
	if err = tx.QueryRowContext(ctx, "SELECT e2ee_key_id FROM server_state WHERE id=1").Scan(&configured); err != nil {
		return err
	}
	if configured != packet.KeyID {
		return memberError(409, "KEY_ID_MISMATCH")
	}
	var owner, oldChannel string
	var oldNonce, oldCipher []byte
	err = tx.QueryRowContext(ctx, "SELECT owner_device_id,channel_id,nonce,ciphertext FROM attachments WHERE attachment_id=?", id).Scan(&owner, &oldChannel, &oldNonce, &oldCipher)
	if err == nil {
		if owner != access.DeviceID || oldChannel != channel || !bytes.Equal(oldNonce, nonce) || !bytes.Equal(oldCipher, cipher) {
			return memberError(409, "ATTACHMENT_CONFLICT")
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM attachments WHERE message_id IS NULL AND created_at<=?", s.now().UnixMilli()-600000); err != nil {
		return err
	}
	var pending int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM attachments WHERE owner_device_id=? AND message_id IS NULL", access.DeviceID).Scan(&pending); err != nil {
		return err
	}
	if pending >= 3 {
		return memberError(429, "ATTACHMENT_LIMIT")
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO attachments(attachment_id,channel_id,owner_device_id,crypto_context_id,nonce,ciphertext,created_at) VALUES(?,?,?,?,?,?,?)", id, channel, access.DeviceID, packet.KeyID, nonce, cipher, s.now().UnixMilli()); err != nil {
		return err
	}
	if err = s.enforceMemberStorageTx(ctx, tx, 0); err != nil {
		return err
	}
	return s.commitDelivery(ctx, tx)
}

func (s *membershipStore) attachment(ctx context.Context, token, channel, id string) (memberInvitePackage, string, error) {
	packet := memberInvitePackage{Version: 2}
	var author string
	if !validHexID(channel, 32) || !validHexID(id, 32) {
		return packet, author, memberError(400, "INVALID_ATTACHMENT")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return packet, author, err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return packet, author, err
	}
	if !access.allows("chat.read") {
		return packet, author, memberError(403, "FORBIDDEN")
	}
	var nonce, cipher []byte
	err = tx.QueryRowContext(ctx, "SELECT a.crypto_context_id,a.nonce,a.ciphertext,m.author_profile_id FROM attachments a JOIN messages m ON m.message_id=a.message_id WHERE a.attachment_id=? AND a.channel_id=? AND m.channel_id=?", id, channel, channel).Scan(&packet.KeyID, &nonce, &cipher, &author)
	if errors.Is(err, sql.ErrNoRows) {
		return packet, author, memberError(404, "ATTACHMENT_NOT_FOUND")
	}
	if err != nil {
		return packet, author, err
	}
	packet.Nonce = b64.EncodeToString(nonce)
	packet.Ciphertext = b64.EncodeToString(cipher)
	return packet, author, tx.Commit()
}
