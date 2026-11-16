# PawTalk Client 0.10.0 — Invitations, LAN connections and room privacy

[Русский](client-v0.10.0.ru.md) · [Exact historical release body](client-v0.10.0.md)

This is a published preview release; it is not necessarily the latest compatible version.

## Changes and installation

Improved invitations, LAN connections and saved-room access.

### Added

- **Invitation entry:** accept the legacy Manager paste format and request a missing password or E2EE key.

### Fixed

- **LAN connections:** voice stays on the verified room HTTPS address through `/rtc`, rather than switching to an unreachable public IP.
- **Bookmarks:** deduplicate the same verified room across invitation/password changes; refresh saved credentials after successful login.
- **Activity privacy:** stale credentials cannot borrow the active session token or reveal participants/unread activity.
- **Temporary rooms:** the pinned embedded server includes the backport that denies anonymous occupancy requests.

### Install or update

Install over the existing client. Permanent rooms also require [Server 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.10.1) for server-side activity privacy; a client upgrade alone is insufficient. [Manager 0.2.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.0) is available for Windows.

## Full release record

The [immutable body snapshot](client-v0.10.0.md) keeps the complete published/approved text, original download links, limitations, signature and verification details. For current installation use the [live component catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and current compatibility guide.
