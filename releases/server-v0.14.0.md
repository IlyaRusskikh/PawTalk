# PawTalk Server 0.14.0 — Protected access and migration

Preview. Changes since Server 0.13.0.
Предварительный выпуск. Изменения относительно Server 0.13.0.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.0/PawTalk.Server.0.14.0.windows-x64.zip)

## Русский

### Добавлено

- API 3 добавляет правила доступа к каналам, подписанные изменения политики и доставку зашифрованных пакетов ключей для голоса, чата и истории.
- Владелец постоянной комнаты API 2 может подготовить управляемую миграцию с резервной копией и явным подтверждением переключения.
- API 2 поддерживает уменьшенные версии медиа через согласуемую возможность.

### Установка и обновление

Сделайте резервную копию. Обновите Server через Manager. Само обновление сохраняет существующую комнату на API 2. Для перехода на API 3 используйте Manager 0.7.0 и Client 0.15.0. Запланируйте простой для переключения.

## English

### Added

- API 3 adds channel access rules, signed policy changes and encrypted key package delivery for voice, chat and history.
- Owners of permanent API 2 rooms can prepare a managed migration with a backup and explicit cutover confirmation.
- API 2 supports smaller media variants through a negotiated capability.

### Install or update

Back up the room and update Server through Manager. The Server update leaves an existing room on API 2. Use Manager 0.7.0 and Client 0.15.0 for the move to API 3. Schedule downtime for cutover.

## Ограничения / Limitations

API 1 не поддерживается. Отзыв доступа не удаляет ранее полученные данные и ключи с устройств. Внешние сети и работа под нагрузкой требуют отдельной приёмки.

API 1 is unsupported. Revoking access does not delete previously delivered data or keys from devices. External networks and production load require separate acceptance.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.0.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.0

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.0/LICENSE)
