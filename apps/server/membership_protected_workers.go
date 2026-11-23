package main

import (
	"context"
	"log"
	"sync"
	"time"

	"pawtalk/server/internal/access"
)

func (p *protectedRuntime) startWorkers(parent context.Context, cfg config) func() {
	ctx, cancel := context.WithCancel(parent)
	var workers sync.WaitGroup
	store := access.NewStoreWithClock(p.store.db, p.store.now)
	workers.Go(func() {
		runProtectedPeriodic(ctx, time.Hour, func() {
			if err := store.PruneAudit(ctx); err != nil && ctx.Err() == nil {
				log.Printf("Protected audit cleanup: %v", err)
			}
		})
	})
	workers.Go(func() {
		runProtectedPeriodic(ctx, time.Second, func() {
			if err := store.FreezeExpiredPolls(ctx, p.pollSource()); err != nil && ctx.Err() == nil {
				log.Printf("Protected poll completion: %v", err)
			}
		})
	})
	workers.Go(func() {
		p.store.runProtectedVoiceControl(ctx, cfg, time.Second, func(err error) {
			log.Printf("Protected voice reconciliation: %v", err)
		})
	})
	return func() {
		cancel()
		workers.Wait()
	}
}

func runProtectedPeriodic(ctx context.Context, interval time.Duration, step func()) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		step()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
