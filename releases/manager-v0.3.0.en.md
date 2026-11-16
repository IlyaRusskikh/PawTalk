# PawTalk Manager 0.3.0 — Desktop controls, live tray and Windows updates

[Русский](manager-v0.3.0.ru.md) · [Canonical snapshot](manager-v0.3.0.md)

Published preview release; check newer tags for current compatible versions.

## Changes and installation

### Added

- A dedicated management window for service status, start/stop, password and invitation copying, networking, E2EE, history, updates, backups and diagnostics, in Russian and English.
- The tray reflects actual service status: green for running, yellow for transitions and red for stopped. Hide removes only the icon; relaunching restores control. Exit Manager stops Server before closing.

### Fixed

- Saving settings while Server is stopped keeps it stopped; the next start uses the new settings. Backup, restore and Server updates also preserve stopped state.
- Operations have time limits and the window can be hidden while work continues. Concurrent configuration changes require a reload instead of overwriting newer settings with stale values.

### Changed

- Manager checks for updates at startup and every ten minutes, including when automatic installation is disabled. Available updates appear in the window and tray.
- Windows updates Manager through the complete installer, updating the window, Go host and controller together. Signed metadata, version, size and SHA-256 are checked before execution. With automatic updates enabled, a separate SYSTEM task runs the installer without another confirmation. Installation may interrupt a call. Linux retains signed-bundle updates.
- The ordinary tray runs without elevation. The window's first protected action, including configuration retrieval, requests UAC for a separate broker. Passwords and invitations go directly to the system clipboard, never into page text or settings snapshots.

### Install or update

On Windows, install the new EXE over the existing Manager. Upgrading from 0.2.x requires the complete EXE: a Python bundle alone does not deliver the new window and Go host. Room data, certificate, password and settings remain; removing data during uninstallation is still a separate choice. Plan a maintenance interruption: installation may stop the current call. Updating preserves a stopped server; its next ordinary start uses saved settings.

On Linux, use the existing Manager update mechanism with signed `manager-manifest.json` and its matching bundle. The new window is Windows-only. Installed Server 0.10.1 and Client 0.11.0 need no upgrade for this Manager; installing Manager does not itself replace the installed Server version. Configuration and data schemas are unchanged.

## Full release record

The [unchanged bilingual snapshot](manager-v0.3.0.md) retains original release limitations, assets and verification details exactly. Consult the [current download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) for today's supported pairings.
