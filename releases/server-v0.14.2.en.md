# PawTalk Server 0.14.2 — Role colors in protected chat

[Русский](server-v0.14.2.ru.md) · [Canonical bilingual source](server-v0.14.2.md)

Preview. Changes since Server 0.14.1.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.2/PawTalk.Server.0.14.2.windows-x64.zip)

### Added

- The protected channel roster includes colors for roles assigned to members who can access the channel. Client uses these colors to style verified role mentions.

### Install or update

Back up the room, then update Server through Manager or use the matching Windows package or Linux image. Role-colored mentions require Client 0.15.1.

## Limitations

The color field is optional. Older clients use the default mention style. Existing API 2 rooms require explicit activation to move to API 3.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.2.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.2

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.2) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.2/LICENSE)
