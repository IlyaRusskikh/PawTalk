# PawTalk Server 0.15.0 — Voice grants for screen sharing

Preview. Changes since Server 0.14.3.
Предварительный выпуск. Изменения относительно Server 0.14.3.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.15.0/PawTalk.Server.0.15.0.windows-x64.zip)

## Русский

### Добавлено

- Голосовые комнаты API 2 и API 3 разрешают отдельные дорожки видео и звука демонстрации в существующем зашифрованном звонке.
- В защищённых комнатах действующие права публикации применяются к микрофону и обеим дорожкам демонстрации.

### Установка и обновление

Сделайте резервную копию комнаты и обновите Server через Manager либо используйте соответствующий пакет Windows или образ Linux. Для демонстрации экрана нужен Client 0.16.0.

## English

### Added

- API 2 and API 3 voice rooms authorize screen video and stream audio as dedicated sources in the existing encrypted call.
- Protected rooms apply current publishing permissions to the microphone and both screen-sharing sources.

### Install or update

Back up the room, then update Server through Manager or use the matching Windows package or Linux image. Use Client 0.16.0 for screen sharing.

## Ограничения / Limitations

Старые Client могут воспроизводить звук демонстрации как обычный звук звонка. Для существующих комнат API 2 переход на API 3 активируется явно.

Older Clients may treat stream audio as regular call audio. Existing API 2 rooms require explicit activation to move to API 3.

## Файлы и исходники / Assets and source

PawTalk.Server.0.15.0.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.15.0

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.15.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.15.0/LICENSE)
