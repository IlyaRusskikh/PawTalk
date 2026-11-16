# PawTalk Client 0.9.0 — Independent updates and server compatibility

[Русский](client-v0.9.0.ru.md) · [Exact historical release body](client-v0.9.0.md)

This is a published preview release; it is not necessarily the latest compatible version.

## Changes and installation

Independent client updates while retaining temporary Windows rooms.

### Added

- **Independent updates:** discover `client-v*` releases separately from Server and Manager, validating family, channel and signature.
- **Server compatibility:** check the API protocol before login; protocol 1 retains support for Server 0.8.0.
- **E2EE key setup:** copy the SHA-256 key ID for the server separately from the participants’ secret.

### Fixed

- The available-update button sits above Settings without shifting page content.
- The installer waits for its successor and reports failures instead of declaring success early.

### Install or update

From Client 0.8.0, install the [v0.8.1 bridge](https://github.com/IlyaRusskikh/PawTalk/releases/tag/v0.8.1) first, then Client 0.9.0. For a manual upgrade, quit from the tray and install over the existing client. Temporary Windows hosting remains available; this installer does not install a permanent service.

## Full release record

The [immutable body snapshot](client-v0.9.0.md) keeps the complete published/approved text, original download links, limitations, signature and verification details. For current installation use the [live component catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and current compatibility guide.
