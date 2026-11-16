# PawTalk Manager 0.4.0 — First-open fix and local Server packages

[Русский](manager-v0.4.0.ru.md) · [Canonical snapshot](manager-v0.4.0.md)

Published preview release; check newer tags for current compatible versions.

## Changes and installation

### Added

- Offline installation of Windows Server ZIPs and portable packages, showing version, SHA-256 and signature status before approval. Unsigned local builds require confirmation, use separate binary directories and may reuse a version number. Installation backs up the room and rolls back failed starts.
- Delete individual backups in the UI with date/name confirmation and an immediate refreshed list. Pending recovery sources and unsafe paths cannot be deleted.
- Check Server availability before offering an update installation.

### Fixed

- The first tray double-click or Settings command opens the window without another request. GUI startup and restart after updates no longer suppress the first show through Windows SW_HIDE.
- Loading settings no longer fails when publishing public status in the installation directory. Status uses a separate access policy without exposing private configuration.
- Metadata requests do not hold the room lock. Settings, logs and diagnostics remain readable during maintenance; backup creation returns its refreshed list in the same response.

### Changed

- The installer no longer displays invitations. Copy invitations/passwords from Manager Overview.
- Manual Manager checks do not trigger installation. Interactive checks have time limits and their progress stays on Updates.
- Successfully installing an unsigned local build disables Server auto-updates so maintenance does not replace the test binary. Re-enable them in the UI when desired.

### Installation and upgrade

Install `PawTalk.Server.Manager.Setup.0.4.0.exe` over the existing Windows Manager. Configuration, identity, history and backups are retained; replacing service files may interrupt a call. Client and Server versions do not change automatically. Local packages and the graphical window are Windows features; Linux retains its console Manager and signed bundles.

For published Server ZIPs, place `server-manifest.json` beside the ZIP or include it in the portable package. Invalid signatures never fall back to unsigned installation. Approving a package without a manifest explicitly trusts the selected code; a checksum alone does not establish authorship.

### Limitations

Local-build backup migration to a fresh installation through Linux/CLI is unsupported; keep the original package. Initial Manager setup still needs its published signed dependencies. No Authenticode signature is claimed for the EXE. Local synthetic tests do not establish external-network, physical-device or SYSTEM auto-installer coverage. Release-tag verification is separate from branch verification.

## Full release record

The [unchanged bilingual snapshot](manager-v0.4.0.md) retains original release limitations, assets and verification details exactly. Consult the [current download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) for today's supported pairings.
