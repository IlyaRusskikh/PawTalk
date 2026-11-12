# PawTalk Server 0.10.1 — Activity privacy and IP changes

Предварительный выпуск / Public preview.

**[Windows x64 ZIP](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.10.1/PawTalk.Server.0.10.1.windows-x64.zip)** · Linux amd64/arm64: `ghcr.io/ilyarusskikh/pawtalk-server:0.10.1`

## Русский

Закрыт просмотр активности без действующего доступа; добавлена смена публичного IP с сохранением комнаты.

### Добавлено

- **Смена публичного IP.** Команда `serve rebind` меняет адрес и TLS-сертификат, сохраняя пароль и историю. После смены адреса нужно новое приглашение.

### Исправлено

- **Защита активности.** Участники, заполненность и предпросмотр непрочитанного требуют текущей авторизации.
- **Отзыв доступа.** Штатная смена пароля native-сервера отзывает прежние токены голоса, чата и предпросмотра; доступ preview привязан также к текущей политике E2EE.

### Установка и обновление

Обновите именно Server через `pawtalkctl update now` (на Windows — от администратора). Одного обновления Client или переустановки Manager недостаточно: они не заменяют установленную версию Server. Перед обновлением сохраните backup; обновление одной комнаты прерывает звонок. Тег `server-v0.10.0` остановился на проверке до публикации и сохранён без изменений; исправленный выпуск — 0.10.1.

## English

Require current authorization for room activity and support changing the public IP while retaining room data.

### Added

- **Public IP changes:** `serve rebind` changes the address and TLS certificate while retaining the password and history. Copy a new invitation afterward.

### Fixed

- **Activity privacy:** participants, occupancy and unread previews require current authorization.
- **Access revocation:** native password reset revokes previous voice, chat and preview tokens; preview access is also bound to the current E2EE policy.

### Install or update

Upgrade Server itself with `pawtalkctl update now` (as administrator on Windows). Updating Client or reinstalling Manager does not replace the installed Server version. Back up first; a single-room update interrupts calls. Verification of `server-v0.10.0` failed before publication; that tag remains unchanged and 0.10.1 is the corrected release.

## Ограничения / Limitations

Это preview. Реальные микрофоны, игры/PTT/UAC, внешние сети и высокая нагрузка требуют отдельной приёмки; локальные проверки с синтетическим звуком её не заменяют. Приглашения, пароли и E2EE-секреты передавайте лично.

This is a preview. Physical microphones, games/PTT/UAC, external networks and load need separate acceptance; local synthetic-audio checks do not replace it. Share invitations, passwords and E2EE secrets privately.

## Файлы, исходники и проверки / Assets, source and verification

- `PawTalk.Server.0.10.1.windows-x64.zip` — нативный Windows-сервер / native Windows server.
- `server-manifest.json` — подписанные SHA-256/размер ZIP и digest Linux-образа / signed ZIP hash/size and Linux image digest.
- Linux image: amd64/arm64; Manager проверяет подписанный digest / Manager verifies the signed digest.

[Исходники этого выпуска / Corresponding source](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.10.1) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[Changelog](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.10.1/CHANGELOG.md) · [Руководство / Guide](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.10.1/docs/SERVER.md) · [Проверки / Verification record](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.10.1/docs/VERIFICATION.md).

[Успешный выпускной CI / Successful tag workflow](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43137302074).
