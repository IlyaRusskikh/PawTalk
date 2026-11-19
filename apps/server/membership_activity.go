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
	var previous bool
	prior := tx.QueryRowContext(ctx, "SELECT away FROM session_activity WHERE session_id=?", access.SessionID).Scan(&previous)
	if prior == nil && previous == away {
		return nil
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO session_activity(session_id,away) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET away=excluded.away", access.SessionID, away); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.events.publish(memberEvent{Type: "state"})
	}
	return err
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
