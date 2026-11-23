package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

type standaloneMigrationStore struct {
	*membershipStore
	identitySHA256 string
	archiveSHA256  string
	active         bool
}

// A missing file or an API 2 version belongs to normal startup. Once the
// migration version is present, failure to prove its checkpoint is terminal.
func openStandaloneMigrationStore(path string) (*standaloneMigrationStore, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	db, err := openMembershipReadOnly(path)
	if err != nil {
		return nil, err
	}
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil ||
		(version != membershipMigrationSchemaVersion && version != protectedDataSchemaVersion) {
		db.Close()
		return nil, err
	}
	authority, err := readFrozenMigrationAuthority(context.Background(), db)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("open migration checkpoint: %w", err)
	}
	return &standaloneMigrationStore{
		membershipStore: &membershipStore{db: db, now: time.Now}, identitySHA256: authority.hostIdentitySHA256, archiveSHA256: authority.archiveSHA256,
		active: version == protectedDataSchemaVersion,
	}, nil
}

func serveStandaloneMigration(ctx context.Context, store *membershipStore, path string, certificate tls.Certificate, automatic bool) error {
	writer, err := openMigrationImportDatabase(path)
	if err != nil {
		return err
	}
	defer writer.Close()
	importer := &membershipStore{db: writer, now: store.now}
	var controlDir string
	if automatic {
		controlDir = filepath.Dir(path)
	}
	server := standaloneHTTPServer(newProtectedMigrationHandlerWithControl(store, importer, controlDir), certificate)
	server.ReadTimeout = 2 * time.Minute
	server.WriteTimeout = 2 * time.Minute
	return serveStandaloneTLS(ctx, server, "PawTalk migration maintenance ready.", nil)
}

func serveStandaloneProtectedRuntime(ctx context.Context, dir, path, archive string, state serverState, certificate tls.Certificate) error {
	db, err := openMigrationImportDatabase(path)
	if err != nil {
		return err
	}
	defer db.Close()
	runtime, err := openProtectedRuntime(ctx, &membershipStore{db: db, now: time.Now}, dir, archive)
	if err != nil {
		return err
	}
	return serveStandaloneRuntime(ctx, runtime, state, certificate)
}

func serveStandaloneRuntime(ctx context.Context, runtime *protectedRuntime, state serverState, certificate tls.Certificate) error {
	media, err := startStandaloneMedia(ctx, state)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	if err != nil {
		return err
	}
	defer media.shutdown()
	cfg := standaloneMediaConfig(state)
	target, err := url.Parse(cfg.PresenceURL)
	if err != nil {
		return err
	}
	stopWorkers := runtime.startWorkers(ctx, cfg)
	defer stopWorkers()
	server := standaloneHTTPServer(runtime.handlerWithVoice(cfg, target), certificate)
	return serveStandaloneTLS(ctx, server, "PawTalk protected API 3 ready.", media.done)
}

func serveAutomaticMigration(ctx context.Context, dir, path string, migration *standaloneMigrationStore, state serverState, certificate tls.Certificate) error {
	digest, err := migrationFileSHA256(filepath.Join(dir, standaloneMigrationBackup))
	if err != nil || digest != migration.archiveSHA256 {
		return errors.New("automatic migration backup does not match the checkpoint")
	}
	maintenance, stop := context.WithCancel(ctx)
	defer stop()
	checked := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			var approved bool
			err := migration.db.QueryRowContext(maintenance, `SELECT EXISTS(
				SELECT 1 FROM sqlite_schema WHERE type='table' AND name='protected_migration_cutover_approval')`).Scan(&approved)
			if err != nil || approved {
				checked <- err
				stop()
				return
			}
			select {
			case <-maintenance.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	if err := serveStandaloneMigration(maintenance, migration.membershipStore, path, certificate, true); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return nil
	}
	if err := <-checked; err != nil {
		return err
	}
	if _, err := activateStandaloneProtectedRuntime(ctx, dir, migration.archiveSHA256); err != nil {
		return err
	}
	return serveStandaloneProtectedRuntime(ctx, dir, path, migration.archiveSHA256, state, certificate)
}

func serveStandaloneTLS(ctx context.Context, server *http.Server, ready string, mediaDone chan error) error {
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", standalonePort))
	if err != nil {
		return err
	}
	defer listener.Close()
	served := make(chan error, 1)
	go func() { served <- server.Serve(tls.NewListener(listener, server.TLSConfig)) }()
	log.Print(ready)
	select {
	case <-ctx.Done():
	case mediaErr := <-mediaDone:
		mediaDone <- mediaErr // shutdown still owns the process exit result
		err = fmt.Errorf("media server exited: %v", mediaErr)
	case err = <-served:
	}
	shutdownStandaloneHTTP(server)
	return err
}
