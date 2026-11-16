# PawTalk Manager 0.1.0 — Server installation, backups and recovery

[Русский](manager-v0.1.0.ru.md) · [Canonical snapshot](manager-v0.1.0.md)

Published preview release; check newer tags for current compatible versions.

## Changes and installation

The first Server Manager release for installing and maintaining persistent Linux or Windows servers.

### Added

- **Server setup:** a Russian/English Windows EXE wizard with native services; Compose installation on Linux.
- **Verified updates:** independent Server/Manager versions and trust roots; signatures and archives are checked before installation. Encryption and automatic updates default to enabled in the wizard and can be disabled.
- **Backup and restore:** stopped, consistent backups; health-checked updates with rollback of configuration, data and server version.
- **Maintenance:** doctor diagnostics, a durable operation journal, crash recovery, bounded restart attempts and Manager-only updates without unnecessary server restarts.

### Fixed

- The wizard validates answers before advancing, handles pasted input and requests a key ID whenever E2EE is enabled.
- Windows setup waits for the successor installer and reports its failure.

### Install or update

Use the Manager EXE on Windows and the server guide on Linux. This is the first Manager version; no Swarm migration is provided. Share the E2EE secret privately with participants; Manager takes only its SHA-256 key ID.

## Full release record

The [unchanged bilingual snapshot](manager-v0.1.0.md) retains original release limitations, assets and verification details exactly. Consult the [current download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) for today's supported pairings.
