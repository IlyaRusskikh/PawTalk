# PawTalk Server 0.14.3 — Client update relay for protected rooms

[Русский](server-v0.14.3.ru.md) · [Bilingual source](server-v0.14.3.md)

Preview. Changes since Server 0.14.2.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.3/PawTalk.Server.0.14.3.windows-x64.zip)

### Fixed

- Protected API 3 rooms can relay the Client release catalog, signed update manifest and installer downloads through the existing update endpoints. Permanent rooms cache downloads in their state directory.

### Install or update

Back up the room, then update Server through Manager or use the matching Windows package or Linux image. Existing Clients with relay support can use an updated room for their update checks.

## Limitations

The relay remains subject to the host’s update-proxy setting and needs access to the upstream GitHub release assets on a cache miss. Existing API 2 rooms require explicit activation to move to API 3.

## Assets and source

PawTalk.Server.0.14.3.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.3

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.3) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.3/LICENSE)
