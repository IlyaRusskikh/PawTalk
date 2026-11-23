package access

import (
	"context"
	"database/sql"
)

type SessionQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type Principal struct {
	ProfileID string
	DeviceID  string
}

// ResolveSession runs on the same SQLite connection and snapshot as the
// operation. The transport supplies this function with the bearer credential.
type ResolveSession func(context.Context, SessionQuery) (Principal, error)
