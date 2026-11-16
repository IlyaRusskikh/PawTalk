# PawTalk Manager 0.5.0 — UI-first setup and API 2 admission

[Русский](manager-v0.5.0.ru.md) · [Canonical snapshot](manager-v0.5.0.md)

Historical **unpublished failed candidate**, retained for verification only.

## Changes and installation

### Added

- On Windows, initial and subsequent Server setup live in the Electron UI: choose a local package or explicitly download a published Server, configure address/ports and start it. Reinstalling Manager does not automatically download or install Server.
- One-use first-administrator API 2 invitation through UI/CLI. Configured servers issue regular invitations through authorized administrator/moderator Clients.

### Fixed

- Setup selects only Manager language and no longer runs the old room-configuration step that could fail installation. Removed the legacy Win32 settings form, including test paths.
- Local packages, backup/restore, updates and diagnostics account for API/data schema 2 while preserving signature, size and compatibility checks.

### Changed

- Password/manual E2EE generation fields give way to membership and mandatory client-side encryption. Windows/Linux hosting uses the same Server core as Client selfhost.

### Install or update

Manually install Manager 0.5.0 from a verified EXE/bundle; older Manager lines may reject API 2 metadata. Choose Server 0.11.0 with a fresh API 2 directory and use Client 0.12.0. Reinstalling Manager alone does not upgrade an existing Server. Retain the previous installation and backup separately: API 1 history/membership migration is unsupported and its backups must not be restored as API 2. Replacing/stopping Server interrupts calls. On Linux use the verified bundle and `manager/pawtalkctl` as documented; UAC/SYSTEM or root is needed only for the relevant host operations.

## Full release record

The [unchanged bilingual snapshot](manager-v0.5.0.md) retains original release limitations, assets and verification details exactly. Consult the [current download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) for today's supported pairings.
