package main

import (
	"context"
	"database/sql"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) protectedContentStore() *access.Store {
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	limit := p.store.maxBytes
	if limit == 0 {
		return store
	}
	return store.WithStorageRetention(func(ctx context.Context, tx *sql.Tx) (bool, error) {
		used, err := memberStorageUsed(ctx, tx)
		return used > limit, err
	})
}
