package main

import (
	"archive/tar"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProtectedMigrationMaintenanceFencesLegacyWriters(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(10000, 0)
	clock := func() time.Time { return now }
	path := filepath.Join(t.TempDir(), "membership-v2.sqlite")
	source, err := openMembershipDatabase(path, clock)
	if err != nil {
		t.Fatal(err)
	}
	defer source.db.Close()
	founder := bootstrapTestServer(t, source, newTestMemberSigner(1))
	legacy, err := openMembershipDatabase(path, clock)
	if err != nil {
		t.Fatal(err)
	}
	defer legacy.db.Close()

	backup := copyMigrationDatabase(t, path)
	repacked := copyMigrationDatabase(t, path, "extra.json")
	frozen, err := backup.prepare(ctx, path, now)
	if err != nil || !frozen.Maintenance || frozen.OwnerProfileID != founder.Access.ProfileID {
		t.Fatalf("invalid maintenance checkpoint: %+v, %v", frozen, err)
	}
	for _, statement := range []string{
		"UPDATE channels SET revision=revision+1",
		"UPDATE roles SET name='administrator'",
		"DELETE FROM channels",
		"INSERT OR IGNORE INTO server_avatar(id) VALUES(1)",
	} {
		_, err := legacy.db.Exec(statement)
		if err == nil || !strings.Contains(err.Error(), "PAWTALK_MIGRATION_MAINTENANCE") {
			t.Fatalf("legacy statement %q did not reach the maintenance fence: %v", statement, err)
		}
	}
	if err := source.db.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := openMembershipDatabase(path, clock); err == nil {
		reopened.db.Close()
		t.Fatal("legacy startup reopened the frozen source")
	} else if !strings.Contains(err.Error(), "API 2 startup refused") {
		t.Fatal(err)
	}
	if err := legacy.db.Close(); err != nil {
		t.Fatal(err)
	}
	resumed, err := inspectProtectedMigration(ctx, path, now.Add(24*time.Hour))
	if err != nil || !resumed.Maintenance || resumed.OwnerProfileID != frozen.OwnerProfileID || resumed.OwnerEvidence != frozen.OwnerEvidence ||
		resumed.Inventory["channels"] != frozen.Inventory["channels"] || resumed.DataSchema != membershipMigrationSchemaVersion ||
		!validHexID(frozen.BackupSHA256, 64) || resumed.BackupSHA256 != frozen.BackupSHA256 || resumed.BackupArchiveSHA256 != backup.digest {
		t.Fatalf("restart lost the frozen source: %+v, %v", resumed, err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	resumed, err = backup.prepare(ctx, path, now.Add(72*time.Hour))
	if err != nil || resumed.BackupSHA256 != frozen.BackupSHA256 {
		t.Fatalf("retry with recorded backup failed: %+v, %v", resumed, err)
	}
	if _, err := copyMigrationDatabase(t, path).prepare(ctx, path, now); err == nil || !strings.Contains(err.Error(), "recorded checkpoint") {
		t.Fatalf("different backup satisfied recorded checkpoint: %v", err)
	}
	if _, err := repacked.prepare(ctx, path, now); err == nil || !strings.Contains(err.Error(), "recorded checkpoint") {
		t.Fatalf("different archive with identical SQLite data satisfied recorded checkpoint: %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("retry changed the source: %v", err)
	}
}

func TestProtectedMigrationMaintenanceRollsBackCheckpointAndFence(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(10000, 0)
	path := filepath.Join(t.TempDir(), "membership-v2.sqlite")
	source, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer source.db.Close()
	freezeThenRollback := func() (protectedMigrationReport, error) {
		t.Helper()
		tx, err := source.db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		report, err := readProtectedMigrationSource(ctx, tx, now)
		if err != nil {
			return report, err
		}
		backup := copyMigrationDatabase(t, path)
		snapshot, err := readMigrationBackup(bytes.NewReader(backup.contents), backup.digest)
		if err != nil {
			return report, err
		}
		return freezeProtectedMigrationSource(ctx, tx, report, snapshot, now)
	}
	if report, err := copyMigrationDatabase(t, path).prepare(ctx, path, now); err == nil || report.OwnerBlocker != "JOIN_EVIDENCE_MISSING_OR_INCONSISTENT" {
		t.Fatalf("missing owner did not stop maintenance: %+v, %v", report, err)
	}
	bootstrapTestServer(t, source, newTestMemberSigner(1))
	if report, err := freezeThenRollback(); err != nil || !report.Maintenance {
		t.Fatalf("cannot simulate interruption before commit: %+v, %v", report, err)
	}
	var checkpoint sql.NullString
	err = source.db.QueryRow(`SELECT MIN(name) FROM sqlite_schema WHERE name GLOB 'protected_migration_*'`).Scan(&checkpoint)
	if err != nil || checkpoint.Valid {
		t.Fatalf("interrupted transaction left a partial fence: %v, %v", checkpoint, err)
	}
	if _, err := source.db.Exec("UPDATE channels SET name='legacy before cutover'"); err != nil {
		t.Fatal(err)
	}
	report, err := inspectProtectedMigration(ctx, path, now)
	if err != nil || report.Maintenance || report.DataSchema != membershipSchemaVersion {
		t.Fatalf("interrupted transaction changed the source version: %+v, %v", report, err)
	}
}

func TestProtectedMigrationRequiresVerifiedCurrentManagerBackup(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(10000, 0)
	path := filepath.Join(t.TempDir(), "membership-v2.sqlite")
	source, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer source.db.Close()
	bootstrapTestServer(t, source, newTestMemberSigner(1))
	stale := copyMigrationDatabase(t, path)
	if _, err := source.db.Exec("UPDATE channels SET name='changed after backup'"); err != nil {
		t.Fatal(err)
	}
	if report, err := stale.prepare(ctx, path, now); err == nil || report.Maintenance || !strings.Contains(err.Error(), "does not match the current API 2 database") {
		t.Fatalf("preparation did not reject a stale database: %+v, %v", report, err)
	}
	fresh := copyMigrationDatabase(t, path)
	badDigest := fresh
	badDigest.digest = strings.Repeat("f", 64)
	identityPath := filepath.Join(filepath.Dir(path), "state.json")
	if err := os.WriteFile(identityPath, []byte(`{"changed":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	wrongIdentity := fresh
	fresh = copyMigrationDatabase(t, path)
	for _, c := range []struct {
		backup migrationBackupFixture
		reason string
	}{
		{badDigest, "does not match Manager metadata"},
		{wrongIdentity, "does not match the current host identity"},
		{copyMigrationDatabase(t, path, membershipDatabaseFile+"-wal"), "self-contained SQLite file"},
		{copyMigrationDatabase(t, path, membershipDatabaseFile), "unsafe or duplicate"},
		{copyMigrationDatabase(t, path, "nested/../state.json"), "unsafe or duplicate"},
	} {
		report, err := c.backup.prepare(ctx, path, now)
		if err == nil || !strings.Contains(err.Error(), c.reason) || report.Maintenance {
			t.Fatalf("preparation did not reject %q: %+v, %v", c.reason, report, err)
		}
	}
	current, err := inspectProtectedMigration(ctx, path, now)
	if err != nil || current.DataSchema != membershipSchemaVersion || current.Maintenance || current.BackupSHA256 != "" {
		t.Fatalf("invalid backup altered migration state: %+v, %v", current, err)
	}
	if prepared, err := fresh.prepare(ctx, path, now); err != nil || !prepared.Maintenance {
		t.Fatalf("current self-contained backup did not permit preparation: %+v, %v", prepared, err)
	}
}

func TestProtectedMigrationCannotFreezeBehindAnUncommittedWriter(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(10000, 0)
	path := filepath.Join(t.TempDir(), "membership-v2.sqlite")
	source, err := openMembershipDatabase(path, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer source.db.Close()
	bootstrapTestServer(t, source, newTestMemberSigner(1))
	backup := copyMigrationDatabase(t, path)
	writer, err := source.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	if _, err := writer.Exec("UPDATE channels SET name='pending legacy write'"); err != nil {
		t.Fatal(err)
	}
	if report, err := backup.prepare(ctx, path, now); err == nil || report.Maintenance || !strings.Contains(err.Error(), "SQLITE_BUSY") {
		t.Fatalf("maintenance overtook a pending writer: %+v, %v", report, err)
	}
	if err := writer.Commit(); err != nil {
		t.Fatal(err)
	}
	if report, err := backup.prepare(ctx, path, now); err == nil || report.Maintenance || !strings.Contains(err.Error(), "does not match the current API 2 database") {
		t.Fatalf("maintenance reused a backup after the writer committed: %+v, %v", report, err)
	}
}

func TestProtectedMigrationHostCommandConsumesBackupOnStdin(t *testing.T) {
	const digestEnv = "PAWTALK_TEST_MIGRATION_ARCHIVE_SHA256"
	if digest := os.Getenv(digestEnv); digest != "" {
		if err := standalone([]string{"migration-prepare", digest}); err != nil {
			t.Fatal(err)
		}
		return
	}
	dir := t.TempDir()
	path := filepath.Join(dir, membershipDatabaseFile)
	source, err := openMembershipStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer source.db.Close()
	founder := bootstrapTestServer(t, source, newTestMemberSigner(1))
	if err := source.db.Close(); err != nil {
		t.Fatal(err)
	}
	backup := copyMigrationDatabase(t, path)
	command := exec.Command(os.Args[0], "-test.run=^TestProtectedMigrationHostCommandConsumesBackupOnStdin$")
	command.Env = append(os.Environ(), "PAWTALK_DATA_DIR="+dir, digestEnv+"="+backup.digest)
	command.Stdin = bytes.NewReader(backup.contents)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("host command failed: %v\n%s", err, output)
	}
	var report protectedMigrationReport
	if err := json.NewDecoder(bytes.NewReader(output)).Decode(&report); err != nil {
		t.Fatalf("host command did not emit JSON: %v\n%s", err, output)
	}
	if !report.Maintenance || report.BackupArchiveSHA256 != backup.digest || report.OwnerProfileID != founder.Access.ProfileID {
		t.Fatalf("host command returned an incorrect checkpoint: %+v", report)
	}
}

type migrationBackupFixture struct {
	contents []byte
	digest   string
}

func (f migrationBackupFixture) prepare(ctx context.Context, source string, now time.Time) (protectedMigrationReport, error) {
	return prepareProtectedMigration(ctx, filepath.Dir(source), bytes.NewReader(f.contents), f.digest, now)
}

func copyMigrationDatabase(t *testing.T, source string, extraEntries ...string) migrationBackupFixture {
	t.Helper()
	contents, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	identityPath := filepath.Join(filepath.Dir(source), "state.json")
	identity, err := os.ReadFile(identityPath)
	if os.IsNotExist(err) {
		identity = []byte(`{"fixture":true}`)
		err = os.WriteFile(identityPath, identity, 0600)
	}
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	archive := tar.NewWriter(&output)
	add := func(name string, data []byte) {
		t.Helper()
		if err := archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	add("./"+membershipDatabaseFile, contents)
	add("state.json", identity)
	for _, name := range extraEntries {
		add(name, []byte("synthetic archive member"))
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	// Python tarfile pads the finished archive to a complete 10 KiB record.
	if remainder := output.Len() % 10240; remainder != 0 {
		output.Write(make([]byte, 10240-remainder))
	}
	digest, err := migrationSHA256(bytes.NewReader(output.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	return migrationBackupFixture{contents: output.Bytes(), digest: digest}
}
