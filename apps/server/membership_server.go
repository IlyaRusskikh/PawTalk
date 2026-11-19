package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

func (s *membershipStore) renameServer(ctx context.Context, token, name, expected, requestID string) error {
	name = strings.TrimSpace(name)
	if !validMemberLabel(name) || !validMemberLabel(expected) {
		return memberError(400, "INVALID_SERVER_NAME")
	}
	payload, _ := json.Marshal([]string{name, expected})
	return s.mutate(ctx, token, requestID, "server.rename", "", payload, func(tx *sql.Tx, access memberAccess) error {
		if access.Role != "admin" {
			return memberError(403, "FORBIDDEN")
		}
		result, err := tx.ExecContext(ctx, "UPDATE server_state SET name=? WHERE id=1 AND name=?", name, expected)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return memberError(409, "SERVER_NAME_CHANGED")
		}
		return nil
	})
}

func (a *membershipAPI) renameServer(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name         string `json:"name"`
		ExpectedName string `json:"expectedName"`
		RequestID    string `json:"requestId"`
	}
	if _, err := decodeMemberJSON(w, r, 1024, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.renameServer(r.Context(), memberBearer(r), input.Name, input.ExpectedName, input.RequestID); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
