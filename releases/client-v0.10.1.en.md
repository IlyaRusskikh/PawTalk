# PawTalk Client 0.10.1 — Reliable saved-room reconnects

[Русский](client-v0.10.1.ru.md) · [Exact historical release body](client-v0.10.1.md)

This is a published preview release; it is not necessarily the latest compatible version.

## Changes and installation

Fix intermittent empty password/key prompts when reconnecting to saved rooms.

### Fixed

- **Reconnects:** a stale locked preview no longer opens the login form; try the saved password and E2EE key first.
- **Credential prompts:** prompt after actual authorization rejection, prefill saved fields and keep network failures distinct from invalid credentials.
- **Storage and previews:** read/write the password/key pair together; late preview responses cannot overwrite refreshed access or reveal activity after credentials are removed.

### Install or update

Quit the client from the tray and install over the current version. For Windows service-control fixes also install [Manager 0.2.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.1). An installed Server 0.10.1 needs no replacement.

## Full release record

The [immutable body snapshot](client-v0.10.1.md) keeps the complete published/approved text, original download links, limitations, signature and verification details. For current installation use the [live component catalog](https://ilyarusskikh.github.io/PawTalk/downloads/) and current compatibility guide.
