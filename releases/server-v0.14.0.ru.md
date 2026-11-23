# PawTalk Server 0.14.0 — Protected access and migration

[English](server-v0.14.0.en.md) · [Двуязычный источник](server-v0.14.0.md)

Предварительный выпуск. Изменения относительно Server 0.13.0.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.0/PawTalk.Server.0.14.0.windows-x64.zip)

### Добавлено

- API 3 добавляет правила доступа к каналам, подписанные изменения политики и доставку зашифрованных пакетов ключей для голоса, чата и истории.
- Владелец постоянной комнаты API 2 может подготовить управляемую миграцию с резервной копией и явным подтверждением переключения.
- API 2 поддерживает уменьшенные версии медиа через согласуемую возможность.

### Установка и обновление

Сделайте резервную копию. Обновите Server через Manager. Само обновление сохраняет существующую комнату на API 2. Для перехода на API 3 используйте Manager 0.7.0 и Client 0.15.0. Запланируйте простой для переключения.

## Ограничения

API 1 не поддерживается. Отзыв доступа не удаляет ранее полученные данные и ключи с устройств. Внешние сети и работа под нагрузкой требуют отдельной приёмки.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.0.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.0

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.0/LICENSE)
