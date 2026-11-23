package main

import (
	"archive/tar"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"
)

const standaloneMigrationBackup = "api2-before-migration.tar"

func prepareStandaloneMigration(ctx context.Context, dir string) error {
	report, err := inspectProtectedMigration(ctx, filepath.Join(dir, membershipDatabaseFile), time.Now())
	if err != nil {
		return err
	}
	if report.OwnerBlocker != "" {
		return errors.New("migration owner selection blocked: " + report.OwnerBlocker)
	}
	path := filepath.Join(dir, standaloneMigrationBackup)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		if err := saveStandaloneMigrationBackup(dir, path); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
	} else if err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("migration backup must be a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	digest, err := migrationSHA256(file)
	if err != nil {
		return err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	// The existing transactional checkpoint verifies this backup against the live
	// SQLite bytes and TLS identity before fencing any legacy writes.
	_, err = prepareProtectedMigration(ctx, dir, file, digest, time.Now())
	return err
}

func saveStandaloneMigrationBackup(dir, output string) error {
	file, err := os.CreateTemp(dir, ".api2-migration-*.tar")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	archive := tar.NewWriter(file)
	for _, name := range []string{membershipDatabaseFile, "state.json"} {
		if err := writeMigrationBackupEntry(archive, filepath.Join(dir, name), name); err != nil {
			return err
		}
	}
	if err := archive.Close(); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	// Publish the complete archive without replacing a prior source snapshot.
	return os.Link(file.Name(), output)
}

func writeMigrationBackupEntry(dst *tar.Writer, path, name string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return errors.New("migration source must contain a regular database and host identity")
	}
	if err := dst.WriteHeader(&tar.Header{Name: name, Size: info.Size(), Mode: 0600, Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	_, err = io.Copy(dst, file)
	return err
}
