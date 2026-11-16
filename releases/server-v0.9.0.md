# PawTalk Server 0.9.0 — Signed updates and native Windows hosting

Предварительный выпуск / Public preview.

**[Windows x64 ZIP](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.9.0/PawTalk.Server.0.9.0.windows-x64.zip)** · Linux amd64/arm64: `ghcr.io/ilyarusskikh/pawtalk-server:0.9.0`

## Русский

Первый отдельный выпуск Server: постоянная комната на Linux через Compose или нативно на Windows.

### Добавлено

- **Собственная версия и подпись.** Теги `server-v*`, подписанный манифест Server и образ Linux amd64/arm64; версия больше не привязана к клиенту.
- **Нативный Windows-сервер.** Постоянная комната с Go/LiveKit без Docker и WSL; установка и обслуживание через отдельный Manager.
- **Безопасная выдача первого пароля.** Пароль получают одноразовой командой администратора, он не пишется в журнал.
- **Обновления клиентов.** Серверный relay распознаёт семейство `client-v*`; API сообщает версию протокола и возможности.

### Изменено

- Постоянное развёртывание Linux переведено со Swarm на Docker Compose. Автоматической миграции старого Swarm-развёртывания нет.

### Установка и обновление

Для новой установки используйте [Manager 0.1.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.1.0) и инструкцию своего хоста. Перед переносом старого сервера сохраните резервную копию; не применяйте Compose поверх Swarm как обычное обновление. Первый пароль и исходный E2EE-секрет — разные данные.

## English

The first independent Server release: persistent Linux Compose or native Windows hosting.

### Added

- **Independent version and signature:** `server-v*` tags, signed Server metadata and Linux amd64/arm64 images, independent of the client version.
- **Native Windows hosting:** a persistent Go/LiveKit room without Docker or WSL, installed and maintained by Manager.
- **First-password retrieval:** a one-time administrator command instead of logging the password.
- **Client updates:** the relay recognizes `client-v*`; the API advertises its protocol version and capabilities.

### Changed

- Persistent Linux deployment moves from Swarm to Docker Compose. There is no automatic migration for existing Swarm deployments.

### Install or update

For a fresh installation use [Manager 0.1.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.1.0) and the appropriate host guide. Back up an old deployment before moving it; applying Compose over Swarm is not a supported in-place upgrade. The first password and the original E2EE secret are different credentials.

## Ограничения / Limitations

В этой версии ещё нет последующей защиты активности и отзыва доступа из [Server 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.10.1). Для действующего сервера рекомендуется обновление. / This version predates the activity-privacy and access-revocation fixes in Server 0.10.1; upgrade an active deployment.

Это preview. Реальные микрофоны, игры/PTT/UAC, внешние сети и высокая нагрузка требуют отдельной приёмки; локальные проверки с синтетическим звуком её не заменяют. Приглашения, пароли и E2EE-секреты передавайте лично.

This is a preview. Physical microphones, games/PTT/UAC, external networks and load need separate acceptance; local synthetic-audio checks do not replace it. Share invitations, passwords and E2EE secrets privately.

## Файлы, исходники и проверки / Assets, source and verification

- `PawTalk.Server.0.9.0.windows-x64.zip` — нативный Windows-сервер / native Windows server.
- `server-manifest.json` — подписанные SHA-256/размер ZIP и digest Linux-образа / signed ZIP hash/size and Linux image digest.
- Linux image: amd64/arm64; Manager проверяет подписанный digest / Manager verifies the signed digest.

[Исходники этого выпуска / Corresponding source](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.9.0) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[Changelog](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.9.0/CHANGELOG.md) · [Руководство / Guide](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.9.0/docs/SERVER.md) · [Проверки / Verification record](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.9.0/docs/VERIFICATION.md) · [Полный diff / Full diff](https://github.com/IlyaRusskikh/PawTalk/compare/v0.8.0...server-v0.9.0).
