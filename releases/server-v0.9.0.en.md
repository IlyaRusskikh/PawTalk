# PawTalk Server 0.9.0 — Signed updates and native Windows hosting

[Русский](server-v0.9.0.ru.md) · [Exact historical release body](server-v0.9.0.md)

This is a published preview release; it is not necessarily the latest compatible version.

## Changes and installation

The first independent Server release: persistent Linux Compose or native Windows hosting.

### Added

- **Independent version and signature:** `server-v*` tags, signed Server metadata and Linux amd64/arm64 images, independent of the client version.
- **Native Windows hosting:** a persistent Go/LiveKit room without Docker or WSL, installed and maintained by Manager.
- **First-password retrieval:** a one-time administrator command instead of logging the password.
- **Client updates:** the relay recognizes `client-v*`; the API advertises its protocol version and capabilities.

### Changed

- Persistent Linux deployment moves from Swarm to Docker Compose. There is no automatic migration for existing Swarm deployments.

### Install or update

For a fresh installation use [Manager 0.1.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.1.0) and the appropriate host guide. Back up an old deployment before moving it; applying Compose over Swarm is not a supported in-place upgrade. The first password and the original E2EE secret are different credentials.

## Full release record

The [immutable body snapshot](server-v0.9.0.md) keeps the complete published/approved text, original download links, limitations, signature and verification details. For current installation use the [live component catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and current compatibility guide.
