# PawTalk Client 0.15.0 — Protected rooms

Preview. Changes since Client 0.14.1.
Предварительный выпуск. Изменения относительно Client 0.14.1.

[Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.15.0/PawTalk.Setup.0.15.0.exe)

## Русский

### Добавлено

- Новые временные комнаты используют API 3. Владелец может управлять ролями и доступом к отдельным каналам. Клиенты проверяют ключи голоса, сообщений и истории для соответствующего канала.
- Добавлены восстановление доступа с другого устройства, настройки уведомлений и средства модерации защищённых комнат.
- Чат показывает уменьшенные превью медиа, где это поддерживает Server, и сохраняет оригиналы для скачивания.

### Установка и обновление

Установите обновление Client или запустите установщик Windows x64. Обновите всех участников перед переходом комнаты на API 3. Существующие постоянные комнаты API 2 поддерживаются.

## English

### Added

- New temporary rooms use API 3. Owners can manage roles and access per channel. Clients verify channel-specific voice, message and history keys.
- Protected rooms support access recovery on another device, notification settings and moderation controls.
- Chat shows smaller media previews where the Server supports them and retains originals for download.

### Install or update

Update Client or run the Windows x64 installer. Update all participants before moving a room to API 3. Existing permanent API 2 rooms remain supported.

## Ограничения / Limitations

Ранее полученные ключи и данные остаются на устройствах участников. Проверка на разных внешних сетях и с физическими микрофонами требует отдельной приёмки. EXE без Authenticode.

Previously delivered keys and data remain on participants’ devices. Independent external networks and physical microphones require separate acceptance. The EXE has no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Setup.0.15.0.exe · PawTalk.Licenses.0.15.0.zip · SHA256SUMS.txt · update-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.15.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.15.0/LICENSE)
