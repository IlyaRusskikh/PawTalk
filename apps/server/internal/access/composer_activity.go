package access

import (
	"context"
	"database/sql"
)

// DispatchComposerActivity authorizes a transient chat event without changing history.
func (s *Store) DispatchComposerActivity(ctx context.Context, resolve ResolveSession, channel, kind string, publish func(string)) error {
	return s.dispatchHistory(ctx, resolve, channel, func(conn *sql.Conn, state State, actor Principal, _, _ uint64) error {
		if kind != "idle" {
			permission := "message.send"
			if kind == "recording" {
				permission = "message.voice"
			}
			subject := state.Members[actor.ProfileID]
			timeout, err := readTimeout(ctx, conn, subject)
			if err != nil {
				return err
			}
			subject.TimeoutUntil = timeout.Deadline
			if grant := state.CheckGrant(subject, state.scope(state.Channels[channel]), permission, s.now().UnixMilli()); grant != Allowed {
				return grant
			}
		}
		publish(actor.ProfileID)
		return nil
	})
}
