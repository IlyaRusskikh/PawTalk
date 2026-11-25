# PawTalk Server 0.15.0 — Voice grants for screen sharing

[Русский](server-v0.15.0.ru.md) · [Bilingual source](server-v0.15.0.md)

Preview. Changes since Server 0.14.3.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.15.0/PawTalk.Server.0.15.0.windows-x64.zip)

### Added

- API 2 and API 3 voice rooms authorize screen video and stream audio as dedicated sources in the existing encrypted call.
- Protected rooms apply current publishing permissions to the microphone and both screen-sharing sources.

### Install or update

Back up the room, then update Server through Manager or use the matching Windows package or Linux image. Use Client 0.16.0 for screen sharing.

## Limitations

Older Clients may treat stream audio as regular call audio. Existing API 2 rooms require explicit activation to move to API 3.

## Assets and source

PawTalk.Server.0.15.0.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.15.0

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.15.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.15.0/LICENSE)
