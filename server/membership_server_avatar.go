package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
)

type serverAvatarPatch struct {
	Envelope         json.RawMessage `json:"envelope"`
	ExpectedRevision int64           `json:"expectedRevision"`
	RequestID        string          `json:"requestId"`
}

func (s *membershipStore) patchServerAvatar(ctx context.Context, token string, input serverAvatarPatch) error {
	if input.ExpectedRevision < 1 || len(input.Envelope) == 0 || len(input.Envelope) > 18000 {
		return memberError(400, "INVALID_AVATAR")
	}
	var stored any
	var packet memberInvitePackage
	if string(input.Envelope) != "null" {
		var err error
		packet, err = validateAvatarEnvelope(input.Envelope)
		if err != nil {
			return err
		}
		stored = []byte(input.Envelope)
	}
	payload, _ := json.Marshal(input)
	return s.mutate(ctx, token, input.RequestID, "server.avatar", "", payload, func(tx *sql.Tx, access memberAccess) error {
		if access.Role != "admin" {
			return memberError(403, "FORBIDDEN")
		}
		if stored != nil {
			var key string
			if err := tx.QueryRowContext(ctx, "SELECT e2ee_key_id FROM server_state WHERE id=1").Scan(&key); err != nil {
				return err
			}
			if key != packet.KeyID {
				return memberError(409, "KEY_ID_MISMATCH")
			}
		}
		result, err := tx.ExecContext(ctx, "UPDATE server_avatar SET envelope=?,author_profile_id=?,revision=revision+1 WHERE id=1 AND revision=?", stored, access.EffectiveProfileID, input.ExpectedRevision)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return memberError(409, "REVISION_CONFLICT")
		}
		return nil
	})
}
func (a *membershipAPI) patchServerAvatar(w http.ResponseWriter, r *http.Request) {
	var input serverAvatarPatch
	if _, err := decodeMemberJSON(w, r, 20000, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.patchServerAvatar(r.Context(), memberBearer(r), input); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
