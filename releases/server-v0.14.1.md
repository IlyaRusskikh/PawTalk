# PawTalk Server 0.14.1 — Managed API 3 migration fix

Preview. Changes since Server 0.14.0.
Предварительный выпуск. Изменения относительно Server 0.14.0.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.1/PawTalk.Server.0.14.1.windows-x64.zip)

## Русский

### Исправлено

- Сервер принимает подтверждение из клиента владельца при подготовленной через Manager миграции с API 2 на API 3. Исправлена ошибка `INVALID_API_RESPONSE` при открытии окна переноса.

### Установка и обновление

Если Server 0.14.0 ждёт подтверждения переноса, выполните `pawtalkctl --lang en migration rollback --yes` от имени администратора или root, чтобы восстановить комнату API 2 из подготовленной копии. Сделайте резервную копию и обновите Server через Manager. Подготовьте перенос заново через Manager 0.7.0, подтвердите его в Client 0.15.0 с устройства владельца и активируйте через Manager. Запланируйте простой на подготовку и активацию.

## English

### Fixed

- Server accepts the owner's Client confirmation during a Manager-prepared API 2 to API 3 migration. This fixes `INVALID_API_RESPONSE` when opening the migration dialog.

### Install or update

If Server 0.14.0 is waiting for migration confirmation, run `pawtalkctl --lang en migration rollback --yes` as administrator or root to restore the API 2 room from the prepared backup. Back up the room and update Server through Manager. Prepare migration again with Manager 0.7.0, confirm it from the owner's device in Client 0.15.0, then activate it with Manager. Schedule downtime for preparation and activation.

## Ограничения / Limitations

Для существующих комнат API 2 требуется явная активация переноса. API 1 не поддерживается.

Existing API 2 rooms require explicit cutover. API 1 is unsupported.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.1.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.1

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.1) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.1/LICENSE)
