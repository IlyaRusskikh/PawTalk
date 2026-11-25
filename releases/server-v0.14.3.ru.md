# PawTalk Server 0.14.3 — Ретрансляция обновлений клиента в защищённых комнатах

[English](server-v0.14.3.en.md) · [Двуязычный источник](server-v0.14.3.md)

Предварительный выпуск. Изменения относительно Server 0.14.2.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.14.3/PawTalk.Server.0.14.3.windows-x64.zip)

### Исправлено

- Защищённые комнаты API 3 передают каталог выпусков Client, подписанный манифест обновления и установщики через существующие ручки обновлений. Постоянные комнаты кешируют загрузки в каталоге данных.

### Установка и обновление

Сделайте резервную копию комнаты и обновите Server через Manager либо используйте соответствующий пакет Windows или образ Linux. Клиенты с поддержкой ретрансляции смогут проверять обновления через обновлённую комнату.

## Ограничения

Работа ретранслятора зависит от настройки прокси обновлений на хосте. Если файла нет в кеше, серверу нужен доступ к артефактам выпуска на GitHub. Для существующих комнат API 2 переход на API 3 активируется явно.

## Файлы и исходники

PawTalk.Server.0.14.3.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.14.3

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.14.3) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.14.3/LICENSE)
