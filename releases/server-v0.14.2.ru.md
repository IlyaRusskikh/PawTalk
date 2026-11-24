# PawTalk Server 0.14.2 — Цвета ролей в защищённом чате

[English](server-v0.14.2.en.md) · [Двуязычный источник](server-v0.14.2.md)

Предварительный выпуск. Изменения относительно Server 0.14.1.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.2/PawTalk.Server.0.14.2.windows-x64.zip)

### Добавлено

- Список участников защищённого канала передаёт цвета ролей, представленных среди участников с доступом к этому каналу. Клиент использует эту информацию для оформления проверенных упоминаний ролей.

### Установка и обновление

Сделайте резервную копию комнаты и обновите Server через Manager или используйте соответствующий пакет Windows или образ Linux. Для цветных упоминаний нужен Client 0.15.1.

## Ограничения

Поле цветов необязательное. Старые клиенты отображают упоминания в стандартном оформлении. Для существующих комнат API 2 переход на API 3 активируется явно.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.2.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.2

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.2) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.2/LICENSE)
