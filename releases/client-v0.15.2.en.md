# PawTalk Client 0.15.2 — Chat, viewer and notification fixes

[Русский](client-v0.15.2.ru.md) · [Bilingual source](client-v0.15.2.md)

Preview. Changes since Client 0.15.1.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.15.2/PawTalk.Setup.0.15.2.exe)

### Fixed

- The purr for new messages outside the current view and the taskbar badge work independently of Windows toasts. Deleting a message dismisses its notification.
- In fullscreen, arrow keys browse photos and Space controls video playback immediately. F toggles fullscreen. Small chat images stay at the top left at their natural size without black bars.
- Remove attachments while editing a message inline. If removing the last attachment leaves the message empty, Client asks for confirmation before deleting it.
- The server owner appears in the member list for an assigned role. The Profile and devices button uses the shared settings style.

### Install or update

Update Client or run the Windows x64 installer. Update the Clients in a protected room to display revisions that remove attachments.

## Limitations

The original encrypted attachment in API 3 remains part of protected history. The EXE has no Authenticode signature.

## Assets and source

PawTalk.Setup.0.15.2.exe · PawTalk.Licenses.0.15.2.zip · SHA256SUMS.txt · update-manifest.json

[Source](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.15.2) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.15.2/LICENSE)
