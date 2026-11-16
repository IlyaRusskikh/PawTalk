# PawTalk Server 0.11.0 — API 2 membership and multiple channels

Public preview; changes since Server 0.10.1. Prepared notes; not yet published or verified by tag CI.
Предварительный выпуск; изменения относительно Server 0.10.1. Описание подготовлено; публикация и tag CI ещё не выполнены.

[Windows x64 ZIP](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.11.0/PawTalk.Server.0.11.0.windows-x64.zip) · Linux amd64/arm64: `ghcr.io/ilyarusskikh/pawtalk-server:0.11.0`.

## Русский

### Добавлено

- Несколько текстовых/голосовых каналов, защищённые от удаления основные каналы, административное управление именем сервера и порядком каналов. Членство не требует подключения к голосу.
- Подписанные идентичности устройств, сессии, постоянный реестр участников и привязки устройств в контексте сервера. Основной профиль определяет роль группы; связь предоставляет совместное авторство, отвязка возвращает самостоятельный профиль без переписывания авторов сообщений.
- Равноправные администраторы и фиксированная роль модератора для приглашений. Кики, временные/постоянные баны, сохранение ролей при повторном вступлении и ограничение голоса одним устройством группы.
- Одноразовые 24-часовые и многоразовые часовые приглашения, до 100 действующих каждого типа. Резервирование/подтверждение вступления, одноразовая первоначальная административная ссылка и непрозрачные зашифрованные пакеты ключей.

### Исправлено

- Идемпотентные изменения и проверки ревизий защищают от повторных отправок и конфликтующего изменения каналов/управления. Потерянный ответ передачи управления допускает безопасное повторение.
- Ответы об отказе после проверки личности различают бан и потерю членства, передают доступный срок блокировки; статус привязки сообщает имена участвующих профилей только двум подтверждённым устройствам.

### Изменено

- Новый API/data schema 2 заменяет прежнее ядро; API 1 не поддерживается. E2EE обязательно; ключ создаётся клиентом, сервер хранит только зашифрованные пакеты, сообщения и вложения. Канальные/целевые ключи выводятся клиентами из секрета сервера.
- Селфхост и постоянные Windows/Linux серверы используют общее ядро. Кик/бан/выход отзывают серверное членство и сессии; голосовое соединение штатного клиента завершается при отзыве.

### Установка и обновление

Установите Manager 0.5.0 и Client 0.12.0, затем Server 0.11.0 в новом API 2 каталоге данных. Перед заменой сохраните API 1 установку и backup: автоматической миграции истории, пароля и членства нет; старые клиенты и приглашения несовместимы. Не используйте API 1 backup как API 2 базу. Остановка/замена одного сервера прерывает его звонки. Первого администратора назначьте одноразовой ссылкой через CLI или Manager; последующих назначает администратор в клиенте. Обновление клиента не заменяет отдельно установленный Server.

## English

### Added

- Multiple text/voice channels, protected defaults, administrator-controlled server name and channel order. Membership works without voice.
- Signed device identities, sessions, a persistent roster and server-local device bindings. The primary profile determines group roles; linking grants shared message control, while unlink restores an independent profile without rewriting original authors.
- Equal administrators, a fixed invitation-only moderator role, kicks, temporary/permanent bans, role preservation on rejoin and one voice device per group.
- Single-use 24-hour and reusable one-hour invitations, capped at 100 active invitations of each type. Admission reservation/confirmation, one-use initial administrator setup and opaque encrypted key packages.

### Fixed

- Idempotent mutations and revision checks protect retries and conflicting channel/control updates. A lost control-transfer response can be retried safely.
- Authenticated denial responses distinguish bans from lost membership and expose available expiry; link status exposes participant names only to the two proven devices.

### Changed

- API/data schema 2 replaces the old core; API 1 is unsupported. E2EE is mandatory: clients create the secret, and Server stores encrypted key packages, messages and attachments. Clients derive channel/purpose keys from the server secret.
- Selfhost and permanent Windows/Linux servers share one core. Kick/ban/departure revoke membership and sessions; compliant clients disconnect voice when access is revoked.

### Install or update

Install Manager 0.5.0 and Client 0.12.0, then Server 0.11.0 with a fresh API 2 data directory. Retain the API 1 installation and backup: no automatic history/password/membership migration exists; old clients and invitations are incompatible. Do not restore an API 1 backup into API 2. Stopping/replacing a server interrupts its calls. Create the first administrator's one-use invitation through CLI/Manager; existing administrators appoint later administrators in Client. Updating Client does not replace a separately installed Server.

## Ограничения / Limitations

Нет канальных ограничений по ролям, ротации ключей или forward secrecy; сохранённые ключи/данные нельзя отозвать. LiveKit-токен может действовать до своего срока, даже после отзыва API-сессии. Синтетические проверки не подтверждают внешнюю UDP-связь, аппаратные микрофоны или нагрузку.

No channel role restrictions, automatic key rotation or forward secrecy. Previously retained keys/data cannot be revoked. An issued LiveKit token can remain usable until expiry despite API session revocation. Synthetic tests do not establish external UDP, physical microphone or load acceptance.

## Файлы, исходники и проверка / Assets, source and verification

- `PawTalk.Server.0.11.0.windows-x64.zip`, signed / подписанный `server-manifest.json`; Linux amd64/arm64 image above / образ указан выше.
- Manager verifies component Ed25519 signature, ZIP size/SHA-256 and immutable image digest / Manager проверяет подпись компонента, размер/SHA-256 ZIP и digest образа.
- [Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.11.0) · [CHANGELOG](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.11.0/CHANGELOG.md) · [Server guide](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.11.0/docs/SERVER-API2.md) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.11.0/LICENSE). Third-party notices remain included. No successful tag CI is claimed yet.
