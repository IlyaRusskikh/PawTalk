# PawTalk Server 0.14.1 — Managed API 3 migration fix

[English](server-v0.14.1.en.md) · [Двуязычный источник](server-v0.14.1.md)

Предварительный выпуск. Изменения относительно Server 0.14.0.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.1/PawTalk.Server.0.14.1.windows-x64.zip)

### Исправлено

- Сервер принимает подтверждение из клиента владельца при подготовленной через Manager миграции с API 2 на API 3. Исправлена ошибка `INVALID_API_RESPONSE` при открытии окна переноса.

### Установка и обновление

Если Server 0.14.0 ждёт подтверждения переноса, выполните `pawtalkctl --lang en migration rollback --yes` от имени администратора или root, чтобы восстановить комнату API 2 из подготовленной копии. Сделайте резервную копию и обновите Server через Manager. Подготовьте перенос заново через Manager 0.7.0, подтвердите его в Client 0.15.0 с устройства владельца и активируйте через Manager. Запланируйте простой на подготовку и активацию.

## Ограничения

Для существующих комнат API 2 требуется явная активация переноса. API 1 не поддерживается.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.1.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.1

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.1) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.1/LICENSE)
