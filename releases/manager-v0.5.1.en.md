# PawTalk Manager 0.5.1 — UI-first setup and API 2 admission

[Русский](manager-v0.5.1.ru.md) · [Canonical local publication source](manager-v0.5.1.md)

Published preview release; check newer tags for current compatible versions.

## Changes and installation

### Added

- On Windows, initial and subsequent Server setup live in the Electron UI: choose a local package or explicitly download a published Server, configure address/ports and start it. Reinstalling Manager does not automatically download or install Server.
- One-use first-administrator API 2 invitation through UI/CLI. Configured servers issue regular invitations through authorized administrator/moderator Clients.

### Fixed

- Standalone Manager release checks prepare LiveKit and the Client renderer before building the integration Server fixture.

- Setup selects only Manager language and no longer runs the old room-configuration step that could fail installation. Removed the legacy Win32 settings form, including test paths.
- Local packages, backup/restore, updates and diagnostics account for API/data schema 2 while preserving signature, size and compatibility checks.

### Changed

- Password/manual E2EE generation fields give way to membership and mandatory client-side encryption. Windows/Linux hosting uses the same Server core as Client selfhost.

### Install or update

Manually install Manager 0.5.1 from a verified EXE/bundle; older Manager lines may reject API 2 metadata. Choose Server 0.11.1 with a fresh API 2 directory and use Client 0.12.1. Reinstalling Manager alone does not upgrade an existing Server. Retain the previous installation and backup separately: API 1 history/membership migration is unsupported and its backups must not be restored as API 2. Replacing/stopping Server interrupts calls. On Linux use the verified bundle and `manager/pawtalkctl` as documented; UAC/SYSTEM or root is needed only for the relevant host operations.

## Full release record

The [canonical local bilingual source](manager-v0.5.1.md) retains original release limitations, assets and verification details exactly. Consult the [current download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) for today's supported pairings.

The local source differs from the public GitHub body; see the [recorded differences](README.md). A public correction requires separate owner approval.
