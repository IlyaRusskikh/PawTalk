# PawTalk Server 0.14.1 — Managed API 3 migration fix

[Русский](server-v0.14.1.ru.md) · [Canonical bilingual source](server-v0.14.1.md)

Preview. Changes since Server 0.14.0.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.1/PawTalk.Server.0.14.1.windows-x64.zip)

### Fixed

- Server accepts the owner's Client confirmation during a Manager-prepared API 2 to API 3 migration. This fixes `INVALID_API_RESPONSE` when opening the migration dialog.

### Install or update

If Server 0.14.0 is waiting for migration confirmation, run `pawtalkctl --lang en migration rollback --yes` as administrator or root to restore the API 2 room from the prepared backup. Back up the room and update Server through Manager. Prepare migration again with Manager 0.7.0, confirm it from the owner's device in Client 0.15.0, then activate it with Manager. Schedule downtime for preparation and activation.

## Limitations

Existing API 2 rooms require explicit cutover. API 1 is unsupported.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.1.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.1

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.1) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.1/LICENSE)
