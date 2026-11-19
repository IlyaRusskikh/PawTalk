# PawTalk Client 0.14.0 — Media galleries, voice messages and interactive checklists

[Русский](client-v0.14.0.ru.md) · [Canonical bilingual source](client-v0.14.0.md)

Preview for Windows x64; changes since Client 0.13.0.
Предварительная версия; изменения относительно Client 0.13.0.

[Download / Скачать](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.14.0/PawTalk.Setup.0.14.0.exe)

### Added

- Voice messages from the + menu: inline recording, live waveform, stop and preview before sending. Playback supports pause, seeking, 0.75×/1×/1.5×/2× speed and 0–200% listener volume.
- Up to 50 MiB per MP4/WebM video, GIF, audio or document, and ten attachments per message. Documents preserve original bytes; PNG/JPEG/WebP photos retain a 2 MiB limit. Draft cards provide preview, rename and removal; dragging onto the window shows the destination chat.
- Two-column attachment grids, sender-generated saved video posters and a shared photo/video viewer with sender, date, download, navigation, photo zoom and native fullscreen. Space toggles video playback, arrows seek five seconds, and idle playback hides controls.
- Interactive checklists with editable titles/items, a sender-selected everyone/author checking policy, struck-through completed items and WebSocket synchronization.
- Hover-operated Markdown icon menus for headings, lists, rules and code blocks. Typed tables remain supported. Read-only preview replaces input without changing its height.
- Tenor/Giphy/Klipy GIF-link resolution, including extensionless links and the first animation on search pages. A bounded fallback handles direct Chromium transport failures.
- A refreshed home screen for joining and creating servers.

### Fixed

- Numbered lists, marker spacing, preview alignment, custom scrolling and compact hover timestamps for consecutive messages; hovering the time exposes its full date.
- Other participants’ local gain/mute preferences survive a full Client restart. Windows alerts display sender avatars. Process/window identity matches installed shortcuts for taskbar grouping and startup.
- Installer downloads sample GitHub and configured servers, retain the fastest measured stream without refetching its prefix, and cancel the others. Signed size and SHA-256 checks remain mandatory; integrity violations stop the update.

### Install or update

Install the Windows x64 EXE or use Client updates. Upgrade a permanent Server to 0.13.0 for galleries, shared video posters, 50 MiB attachments and interactive checklists; capabilities determine support. Older API 2 Servers retain their limits. Manager 0.5.1 remains compatible and updates independently. Fully restart Client after updating. If an older taskbar pin still creates another icon, unpin it once and pin the running updated Client again.

## Limitations

Preview. Video attachments do not provide video calls or screen sharing; codec support depends on Electron. External GIF resolution depends on provider availability. Mirror probes estimate current throughput rather than guaranteeing sustained bandwidth. Older Clients cannot display galleries. Reboot behavior with an existing taskbar pin, physical microphones, games/PTT, external networks and sustained load need separate acceptance. The EXE has no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Setup.0.14.0.exe · SHA256SUMS.txt · update-manifest.json · PawTalk.Licenses.0.14.0.zip

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.14.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.14.0/LICENSE)

Independent component Ed25519 manifests verify downloads; third-party notices remain included.
Подписи Ed25519 манифестов компонентов проверяют загрузки; сторонние лицензии включены.
