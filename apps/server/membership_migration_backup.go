package main

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const membershipDatabaseFile = "membership-v2.sqlite"

type migrationBackupSnapshot struct {
	archiveSHA256  string
	databaseSHA256 string
	identitySHA256 string
}

// Manager passes its verified, stopped backup and the digest from metadata.
// Never extract an archive member into the live data directory.
func readMigrationBackup(input io.Reader, expectedSHA256 string) (migrationBackupSnapshot, error) {
	var snapshot migrationBackupSnapshot
	if !validHexID(expectedSHA256, 64) {
		return snapshot, errors.New("invalid migration backup archive SHA-256")
	}
	archiveHash := sha256.New()
	stream := io.TeeReader(input, archiveHash)
	archive := tar.NewReader(stream)
	names := make(map[string]bool)
	for {
		member, err := archive.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return snapshot, errors.New("invalid migration backup archive")
		}
		name := path.Clean(member.Name)
		if strings.ContainsAny(member.Name, `\:`) || path.IsAbs(member.Name) ||
			slices.Contains(strings.Split(member.Name, "/"), "..") || names[name] ||
			(member.Typeflag != tar.TypeReg && member.Typeflag != tar.TypeDir) {
			return snapshot, errors.New("unsafe or duplicate migration backup archive member")
		}
		names[name] = true
		switch name {
		case membershipDatabaseFile + "-journal", membershipDatabaseFile + "-wal", membershipDatabaseFile + "-shm":
			return snapshot, errors.New("migration requires a backup with a self-contained SQLite file")
		case membershipDatabaseFile, "state.json":
			if member.Typeflag != tar.TypeReg || member.Size <= 0 {
				return snapshot, errors.New("migration backup has an invalid database or host identity member")
			}
			digest, err := migrationSHA256(archive)
			if err != nil {
				return snapshot, errors.New("incomplete migration backup archive")
			}
			if name == membershipDatabaseFile {
				snapshot.databaseSHA256 = digest
			} else {
				snapshot.identitySHA256 = digest
			}
		}
	}
	// tar.Reader stops at the end marker. Include any record padding in the
	// same digest Manager captured for the complete archive file.
	if _, err := io.Copy(io.Discard, stream); err != nil {
		return snapshot, errors.New("incomplete migration backup archive")
	}
	snapshot.archiveSHA256 = hex.EncodeToString(archiveHash.Sum(nil))
	if snapshot.archiveSHA256 != expectedSHA256 {
		return snapshot, errors.New("migration backup archive SHA-256 does not match Manager metadata")
	}
	if snapshot.databaseSHA256 == "" || snapshot.identitySHA256 == "" {
		return snapshot, errors.New("migration backup must include the API 2 database and host identity")
	}
	return snapshot, nil
}

// Keep a read lock on the source while hashing in rollback-journal mode. The
// same transaction must acquire the write lock before installing the fence.
func prepareProtectedMigration(ctx context.Context, dir string, input io.Reader, backupSHA256 string, now time.Time) (protectedMigrationReport, error) {
	var report protectedMigrationReport
	snapshot, err := readMigrationBackup(input, backupSHA256)
	if err != nil {
		return report, err
	}
	identitySHA256, err := migrationFileSHA256(filepath.Join(dir, "state.json"))
	if err != nil {
		return report, err
	}
	if identitySHA256 != snapshot.identitySHA256 {
		return report, errors.New("migration backup does not match the current host identity")
	}
	sourcePath := filepath.Join(dir, membershipDatabaseFile)
	query := url.Values{"mode": {"rw"}, "_pragma": {"foreign_keys(1)", "busy_timeout(5000)"}}
	db, err := openExistingMembershipDatabase(sourcePath, query)
	if err != nil {
		return report, err
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return report, err
	}
	defer tx.Rollback()
	var journal string
	if err := tx.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journal); err != nil {
		return report, err
	}
	if journal != "delete" {
		return report, errors.New("migration requires the API 2 DELETE journal mode to verify the backup")
	}
	report, err = readProtectedMigrationSource(ctx, tx, now)
	if err != nil {
		return report, err
	}
	if report.OwnerBlocker != "" {
		return report, errors.New("migration owner selection blocked: " + report.OwnerBlocker)
	}
	if report.Maintenance {
		if report.BackupSHA256 != snapshot.databaseSHA256 || report.BackupArchiveSHA256 != snapshot.archiveSHA256 {
			return report, errors.New("migration backup does not match the recorded checkpoint")
		}
		return report, tx.Commit()
	}
	sourceSHA256, err := migrationFileSHA256(sourcePath)
	if err != nil {
		return report, err
	}
	if sourceSHA256 != snapshot.databaseSHA256 {
		return report, errors.New("migration backup does not match the current API 2 database")
	}
	prepared, err := freezeProtectedMigrationSource(ctx, tx, report, snapshot, now)
	if err != nil {
		return report, err
	}
	if err := tx.Commit(); err != nil {
		return report, err
	}
	return prepared, nil
}

func migrationFileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	return migrationSHA256(file)
}

func migrationSHA256(input io.Reader) (string, error) {
	hash := sha256.New()
	if _, err := io.Copy(hash, input); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
