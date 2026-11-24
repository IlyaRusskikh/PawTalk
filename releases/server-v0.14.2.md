# PawTalk Server 0.14.2 — Role colors in protected chat

Preview. Changes since Server 0.14.1.
Предварительный выпуск. Изменения относительно Server 0.14.1.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.2/PawTalk.Server.0.14.2.windows-x64.zip)

## Русский

### Добавлено

- Список участников защищённого канала передаёт цвета ролей, представленных среди участников с доступом к этому каналу. Клиент использует эту информацию для оформления проверенных упоминаний ролей.

### Установка и обновление

Сделайте резервную копию комнаты и обновите Server через Manager или используйте соответствующий пакет Windows или образ Linux. Для цветных упоминаний нужен Client 0.15.1.

## English

### Added

- The protected channel roster includes colors for roles assigned to members who can access the channel. Client uses these colors to style verified role mentions.

### Install or update

Back up the room, then update Server through Manager or use the matching Windows package or Linux image. Role-colored mentions require Client 0.15.1.

## Ограничения / Limitations

Поле цветов необязательное. Старые клиенты отображают упоминания в стандартном оформлении. Для существующих комнат API 2 переход на API 3 активируется явно.

The color field is optional. Older clients use the default mention style. Existing API 2 rooms require explicit activation to move to API 3.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.2.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.2

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.2) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.2/LICENSE)
