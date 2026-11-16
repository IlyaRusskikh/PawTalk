# PawTalk Server 0.10.1 — Activity privacy and IP changes

[Русский](server-v0.10.1.ru.md) · [Exact historical release body](server-v0.10.1.md)

This is a published preview release; it is not necessarily the latest compatible version.

## Changes and installation

Require current authorization for room activity and support changing the public IP while retaining room data.

### Added

- **Public IP changes:** `serve rebind` changes the address and TLS certificate while retaining the password and history. Copy a new invitation afterward.

### Fixed

- **Activity privacy:** participants, occupancy and unread previews require current authorization.
- **Access revocation:** native password reset revokes previous voice, chat and preview tokens; preview access is also bound to the current E2EE policy.

### Install or update

Upgrade Server itself with `pawtalkctl update now` (as administrator on Windows). Updating Client or reinstalling Manager does not replace the installed Server version. Back up first; a single-room update interrupts calls. Verification of `server-v0.10.0` failed before publication; that tag remains unchanged and 0.10.1 is the corrected release.

## Full release record

The [immutable body snapshot](server-v0.10.1.md) keeps the complete published/approved text, original download links, limitations, signature and verification details. For current installation use the [live component catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and current compatibility guide.
