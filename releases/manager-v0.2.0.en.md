# PawTalk Manager 0.2.0 — Windows tray, settings and ProgramData setup

[Русский](manager-v0.2.0.ru.md) · [Canonical snapshot](manager-v0.2.0.md)

Published preview release; check newer tags for current compatible versions.

## Changes and installation

Windows server tray controls, a settings window and improved installation/removal.

### Added

- **Server tray:** start/stop/exit, invitation copying and password reset; a distinct server badge, desktop shortcut and tray launch at sign-in.
- **Server settings:** edit setup parameters and independent Server/Manager auto-update preferences, with backup, health verification and rollback. IP changes require Server 0.10.1.
- **Optional full uninstall:** a checkbox removes settings/data; otherwise room data is preserved.

### Fixed

- **ProgramData installation:** protected shared directories, migration from Program Files and reuse of existing configuration without repeating setup questions.
- **Invitation/password:** show the invitation once in setup without a duplicate console; protect the recoverable password with per-user DPAPI.
- Reinstallation waits for service exit and pending SCM deletion; invitation requests briefly wait for startup maintenance and transient downloads retry.

### Install or update

Run the EXE over the existing Manager as administrator. Configuration/data are preserved; service replacement briefly interrupts calls. Reinstallation preserves the Server version, so upgrade Server separately to 0.10.1 for activity privacy. Manager stores the E2EE key ID, not the participants’ original secret.

## Full release record

The [unchanged bilingual snapshot](manager-v0.2.0.md) retains original release limitations, assets and verification details exactly. Consult the [current download catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) for today's supported pairings.
