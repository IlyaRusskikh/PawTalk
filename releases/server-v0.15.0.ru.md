# PawTalk Server 0.15.0 — Разрешения на демонстрацию экрана

[English](server-v0.15.0.en.md) · [Двуязычный источник](server-v0.15.0.md)

Предварительный выпуск. Изменения относительно Server 0.14.3.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.15.0/PawTalk.Server.0.15.0.windows-x64.zip)

### Добавлено

- Голосовые комнаты API 2 и API 3 разрешают отдельные дорожки видео и звука демонстрации в существующем зашифрованном звонке.
- В защищённых комнатах действующие права публикации применяются к микрофону и обеим дорожкам демонстрации.

### Установка и обновление

Сделайте резервную копию комнаты и обновите Server через Manager либо используйте соответствующий пакет Windows или образ Linux. Для демонстрации экрана нужен Client 0.16.0.

## Ограничения

Старые Client могут воспроизводить звук демонстрации как обычный звук звонка. Для существующих комнат API 2 переход на API 3 активируется явно.

## Файлы и исходники

PawTalk.Server.0.15.0.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.15.0

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.15.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.15.0/LICENSE)
