# PawTalk Client 0.15.3 — Notification delivery and steadier chat scrolling

[Русский](client-v0.15.3.ru.md) · [Bilingual source](client-v0.15.3.md)

Preview. Changes since Client 0.15.2.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.15.3/PawTalk.Setup.0.15.3.exe)

### Fixed

- New messages in protected rooms can trigger the purr, taskbar badge and Windows toast even when the client and server clocks differ. The taskbar badge updates while the app is minimized.
- Chat keeps the reading position as older messages, image previews and poll voters load. New messages animate into view when you are following the conversation at the bottom.
- New photo and GIF previews reserve their space before download. Replies show a one-line quote, and the typing indicator takes up less space.
- Protected chats show a waiting state while another authorized device shares the encryption key. The chat opens automatically when the key arrives.

### Install or update

Update Client or run the Windows x64 installer. For update relaying in protected rooms, upgrade the permanent host to Server 0.14.3 or use a temporary room hosted by Client 0.15.3.

## Limitations

Exact placeholder dimensions are available for newly sent previews with size metadata. Earlier messages use the existing placeholder until their preview loads. The EXE has no Authenticode signature.

## Assets and source

PawTalk.Setup.0.15.3.exe · PawTalk.Licenses.0.15.3.zip · SHA256SUMS.txt · update-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.15.3) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.15.3/LICENSE)
