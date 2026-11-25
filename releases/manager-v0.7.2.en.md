# PawTalk Manager 0.7.2 — Server updates for API 3 rooms

[Русский](manager-v0.7.2.ru.md) · [Bilingual source](manager-v0.7.2.md)

Preview for Windows and Linux. Changes since Manager 0.7.1.

[Windows GUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Server.Manager.Setup.0.7.2.exe) · [Windows TUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Server.Manager.TUI.Setup.0.7.2.exe) · [Linux](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Manager.0.7.2.tar.gz)

### Fixed

- Manager can update a running room that has already migrated to API 3 from Server 0.14.1 to the signed Server 0.15.0 release. It verifies the active cutover and TLS identity before committing the update. If startup or verification fails, Manager restores the previous Server artifact and room data together.

### Install or update

Update Manager first. On Linux, run `sudo pawtalkctl manager now` or use the Manager update action in the TUI. On Windows, use the installer for your Manager edition. Then open **Updates → Install Server update** in the TUI, with the room running. The update interrupts active calls.

## Limitations

For rooms already using API 3, this update path accepts the published Server 0.15.0 artifacts. Service management requires administrator or root privileges. Windows EXEs have no Authenticode signature.

## Assets and source

PawTalk.Server.Manager.Setup.0.7.2.exe · PawTalk.Server.Manager.TUI.Setup.0.7.2.exe · PawTalk.Manager.0.7.2.tar.gz · manager-manifest.json

[Source](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.7.2) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.7.2/LICENSE)
