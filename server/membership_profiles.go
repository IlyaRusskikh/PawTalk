package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"strings"
)

type memberProfilePatch struct {
	Nickname         string          `json:"nickname"`
	Avatar           json.RawMessage `json:"avatarEnvelope"`
	ExpectedRevision int64           `json:"expectedRevision"`
	RequestID        string          `json:"requestId"`
}

func (s *membershipStore) patchProfile(ctx context.Context, token string, input memberProfilePatch) error {
	input.Nickname = strings.TrimSpace(input.Nickname)
	if !validNickname(input.Nickname) || input.ExpectedRevision < 1 || len(input.Avatar) > 18000 {
		return memberError(400, "INVALID_PROFILE")
	}
	var packet memberInvitePackage
	hasAvatar := len(input.Avatar) > 0 && !bytes.Equal(input.Avatar, []byte("null"))
	if hasAvatar {
		decoder := json.NewDecoder(bytes.NewReader(input.Avatar))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&packet) != nil || packet.Version != 2 || !validHexID(packet.KeyID, 64) {
			return memberError(400, "INVALID_AVATAR")
		}
		if _, err := decodeFixed(packet.Nonce, 12); err != nil {
			return memberError(400, "INVALID_AVATAR")
		}
		cipher, err := b64.Strict().DecodeString(packet.Ciphertext)
		if err != nil || len(cipher) < 17 || len(cipher) > 12016 || b64.EncodeToString(cipher) != packet.Ciphertext {
			return memberError(400, "INVALID_AVATAR")
		}
	}
	hash := sha256.Sum256(input.Avatar)
	payload, _ := json.Marshal([]any{input.Nickname, input.ExpectedRevision, b64.EncodeToString(hash[:])})
	return s.mutate(ctx, token, input.RequestID, "profile.patch", "", payload, func(tx *sql.Tx, access memberAccess) error {
		if hasAvatar {
			var keyID string
			if err := tx.QueryRowContext(ctx, "SELECT e2ee_key_id FROM server_state WHERE id=1").Scan(&keyID); err != nil {
				return err
			}
			if keyID != packet.KeyID {
				return memberError(409, "KEY_ID_MISMATCH")
			}
		}
		var avatar any
		if hasAvatar {
			avatar = []byte(input.Avatar)
		}
		var result sql.Result
		var err error
		var override int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM group_profiles WHERE profile_id=?", access.EffectiveProfileID).Scan(&override); err != nil {
			return err
		}
		if len(input.Avatar) == 0 {
			if override > 0 {
				result, err = tx.ExecContext(ctx, "UPDATE group_profiles SET nickname=?,revision=revision+1 WHERE profile_id=? AND revision=?", input.Nickname, access.EffectiveProfileID, input.ExpectedRevision)
			} else {
				result, err = tx.ExecContext(ctx, "UPDATE profiles SET nickname=?,revision=revision+1 WHERE profile_id=? AND revision=?", input.Nickname, access.EffectiveProfileID, input.ExpectedRevision)
			}
		} else {
			if override > 0 {
				result, err = tx.ExecContext(ctx, "UPDATE group_profiles SET nickname=?,avatar_envelope=?,avatar_profile_id=?,revision=revision+1 WHERE profile_id=? AND revision=?", input.Nickname, avatar, access.EffectiveProfileID, access.EffectiveProfileID, input.ExpectedRevision)
			} else {
				result, err = tx.ExecContext(ctx, "UPDATE profiles SET nickname=?,avatar_envelope=?,revision=revision+1 WHERE profile_id=? AND revision=?", input.Nickname, avatar, access.EffectiveProfileID, input.ExpectedRevision)
			}
		}
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return memberError(409, "PROFILE_CHANGED")
		}
		if _, err = tx.ExecContext(ctx, "UPDATE profile_controls SET revision=revision+1 WHERE profile_id=?", access.EffectiveProfileID); err != nil {
			return err
		}
		return s.enforceMemberStorageTx(ctx, tx, 0)
	})
}
