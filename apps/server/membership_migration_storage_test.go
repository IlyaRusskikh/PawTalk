package main

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// SQLite enforces this limit on the existing connection even when the host
// still has free space. It reports the same result code as a full filesystem.
func limitMigrationDatabasePages(t *testing.T, db *sql.DB) func() {
	t.Helper()
	var pages, previous, limit int64
	if err := db.QueryRow("PRAGMA page_count").Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("PRAGMA max_page_count").Scan(&previous); err != nil {
		t.Fatal(err)
	}
	set := func(count int64) {
		t.Helper()
		if err := db.QueryRow(fmt.Sprintf("PRAGMA max_page_count=%d", count)).Scan(&limit); err != nil || limit != count {
			t.Fatalf("set SQLite page limit to %d: got %d, %v", count, limit, err)
		}
	}
	set(pages)
	return func() { set(previous) }
}

func requireMigrationSQLiteFull(t *testing.T, err error) {
	t.Helper()
	var failure *sqlite.Error
	if !errors.As(err, &failure) || failure.Code() != sqlite3.SQLITE_FULL {
		t.Fatalf("expected SQLITE_FULL, got %v", err)
	}
}

func TestProtectedMigrationMaintenanceFullDiskRollsBack(t *testing.T) {
	ctx := t.Context()
	now := time.Unix(10_000, 0)
	path := filepath.Join(t.TempDir(), membershipDatabaseFile)
	source, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer source.db.Close()
	bootstrapTestServer(t, source, newTestMemberSigner(1))
	if _, err := source.db.Exec("VACUUM"); err != nil {
		t.Fatal(err)
	}
	backup := copyMigrationDatabase(t, path)
	snapshot, err := readMigrationBackup(bytes.NewReader(backup.contents), backup.digest)
	if err != nil {
		t.Fatal(err)
	}
	release := limitMigrationDatabasePages(t, source.db)
	var report protectedMigrationReport
	freeze := func() error {
		tx, err := source.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		report, err = readProtectedMigrationSource(ctx, tx, now)
		if err == nil {
			report, err = freezeProtectedMigrationSource(ctx, tx, report, snapshot, now)
		}
		return err
	}
	requireMigrationSQLiteFull(t, freeze())
	release()
	if report.Maintenance || report.DataSchema != membershipSchemaVersion {
		t.Fatalf("failed freeze reported maintenance: %+v", report)
	}
	var marker bool
	if err := source.db.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name GLOB 'protected_migration_*')").Scan(&marker); err != nil || marker {
		t.Fatalf("failed freeze left staging tables or triggers: %v, %v", marker, err)
	}
	if digest, err := migrationFileSHA256(path); err != nil || digest != snapshot.databaseSHA256 {
		t.Fatalf("failed freeze changed the source database: %q, %v", digest, err)
	}
	if resumed, err := backup.prepare(ctx, path, now); err != nil || !resumed.Maintenance || resumed.BackupArchiveSHA256 != backup.digest {
		t.Fatalf("retry with the original backup failed: %+v, %v", resumed, err)
	}
}

func TestProtectedMigrationFreezeSurvivesProcessCrash(t *testing.T) {
	const ready = "migration freeze writes staged"
	if dir := os.Getenv("PAWTALK_TEST_MIGRATION_CRASH_DIR"); dir != "" {
		stageMigrationFreezeBeforeTestCrash(t, dir)
		fmt.Fprintln(os.Stdout, ready)
		<-time.After(45 * time.Second)
		t.Fatal("the crash fixture process was not terminated")
	}
	ctx, stop := context.WithTimeout(t.Context(), 30*time.Second)
	defer stop()
	now := time.Unix(10_000, 0)
	dir := t.TempDir()
	path := filepath.Join(dir, membershipDatabaseFile)
	source, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer source.db.Close()
	bootstrapTestServer(t, source, newTestMemberSigner(1))
	if err := source.db.Close(); err != nil {
		t.Fatal(err)
	}
	backup := copyMigrationDatabase(t, path)
	if err := os.WriteFile(filepath.Join(dir, "crash-fixture.tar"), backup.contents, 0o600); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, binary, "-test.run=^TestProtectedMigrationFreezeSurvivesProcessCrash$", "-test.v")
	command.Env = append(os.Environ(), "PAWTALK_TEST_MIGRATION_CRASH_DIR="+dir, "PAWTALK_TEST_MIGRATION_CRASH_DIGEST="+backup.digest)
	hideWindow(command)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	}()
	scanner := bufio.NewScanner(stdout)
	var output bytes.Buffer
	for scanner.Scan() {
		if scanner.Text() == ready {
			break
		}
		fmt.Fprintln(&output, scanner.Text())
	}
	if scanner.Text() != ready {
		_ = command.Wait()
		t.Fatalf("fixture did not stage the freeze: %v\n%s\n%s", scanner.Err(), &output, &stderr)
	}
	if file, err := os.Stat(path + "-journal"); err != nil || file.Size() == 0 {
		t.Fatalf("staged writes had no rollback journal: %v", err)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err == nil {
		t.Fatal("crash fixture exited successfully")
	}
	// Reopen with a writable connection so SQLite can replay the hot journal.
	reopened, err := openMigrationImportDatabase(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var suites, version int
	if err := reopened.QueryRow("SELECT COUNT(*) FROM sqlite_schema WHERE name GLOB 'protected_migration_*'").Scan(&suites); err != nil || suites != 0 {
		t.Fatalf("reopened database kept partial migration writes: %d, %v", suites, err)
	}
	if err := reopened.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != membershipSchemaVersion {
		t.Fatalf("crash changed the reopened schema: %d, %v", version, err)
	}
	if resumed, err := backup.prepare(ctx, path, now); err != nil || !resumed.Maintenance || resumed.BackupArchiveSHA256 != backup.digest {
		t.Fatalf("retry after crash with the original backup: %+v, %v", resumed, err)
	}
}

func stageMigrationFreezeBeforeTestCrash(t *testing.T, dir string) {
	t.Helper()
	ctx := t.Context()
	now := time.Unix(10_000, 0)
	archive, err := os.ReadFile(filepath.Join(dir, "crash-fixture.tar"))
	if err != nil {
		t.Fatal(err)
	}
	backup, err := readMigrationBackup(bytes.NewReader(archive), os.Getenv("PAWTALK_TEST_MIGRATION_CRASH_DIGEST"))
	if err != nil {
		t.Fatal(err)
	}
	db, err := openMigrationImportDatabase(filepath.Join(dir, membershipDatabaseFile))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.ExecContext(ctx, "PRAGMA cache_size=1"); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tx.Rollback() })
	report, err := readProtectedMigrationSource(ctx, tx, now)
	if err != nil {
		t.Fatal(err)
	}
	if frozen, err := freezeProtectedMigrationSource(ctx, tx, report, backup, now); err != nil || !frozen.Maintenance {
		t.Fatalf("could not stage freeze writes: %+v, %v", frozen, err)
	}
}
