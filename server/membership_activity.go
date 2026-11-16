package main

import (
	"context"
	"net/http"
)

func (s *membershipStore) setActivity(ctx context.Context, token string, away bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	access, err := s.sessionAccessTx(ctx, tx, token)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO session_activity(session_id,away) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET away=excluded.away", access.SessionID, away); err != nil {
		return err
	}
	return tx.Commit()
}
func (a *membershipAPI) activity(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Away bool `json:"away"`
	}
	if _, err := decodeMemberJSON(w, r, 64, &input); err != nil {
		memberFail(w, err)
		return
	}
	if err := a.store.setActivity(r.Context(), memberBearer(r), input.Away); err != nil {
		memberFail(w, err)
		return
	}
	respond(w, 200, map[string]bool{"ok": true})
}
