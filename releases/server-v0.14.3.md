# PawTalk Server 0.14.3 — Client update relay for protected rooms

Preview. Changes since Server 0.14.2.
Предварительный выпуск. Изменения относительно Server 0.14.2.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.3/PawTalk.Server.0.14.3.windows-x64.zip)

## Русский

### Исправлено

- Защищённые комнаты API 3 передают каталог выпусков Client, подписанный манифест обновления и установщики через существующие ручки обновлений. Постоянные комнаты кешируют загрузки в каталоге данных.

### Установка и обновление

Сделайте резервную копию комнаты и обновите Server через Manager либо используйте соответствующий пакет Windows или образ Linux. Клиенты с поддержкой ретрансляции смогут проверять обновления через обновлённую комнату.

## English

### Fixed

- Protected API 3 rooms can relay the Client release catalog, signed update manifest and installer downloads through the existing update endpoints. Permanent rooms cache downloads in their state directory.

### Install or update

Back up the room, then update Server through Manager or use the matching Windows package or Linux image. Existing Clients with relay support can use an updated room for their update checks.

## Ограничения / Limitations

Работа ретранслятора зависит от настройки прокси обновлений на хосте. Если файла нет в кеше, серверу нужен доступ к артефактам выпуска на GitHub. Для существующих комнат API 2 переход на API 3 активируется явно.

The relay remains subject to the host’s update-proxy setting and needs access to the upstream GitHub release assets on a cache miss. Existing API 2 rooms require explicit activation to move to API 3.

## Файлы и исходники / Assets and source

PawTalk.Server.0.14.3.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.3

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.3) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.3/LICENSE)
