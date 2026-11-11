# Client 0.9.0 / Server 0.9.0 / Manager 0.1.0

Prepared for review; not published. / Подготовлено к ревью; не опубликовано.

## Русский

- **Client 0.9.0:** независимые обновления по `client-v*`, совместимость API со
  старым Server 0.8.0, сохранение временных Windows-комнат. Кнопка обновления
  находится над настройками в сайдбаре и не сдвигает страницу.
- **Server 0.9.0:** постоянный сервер для Linux (Docker Compose, amd64/arm64) и
  Windows x64 (нативные Go/LiveKit). Одинаковое серверное ядро и общий контроллер
  обслуживания; для Windows не нужны Docker и WSL.
- **Manager 0.1.0:** русско-английский мастер и Windows EXE со встроенным Python,
  системные службы, подписанные независимые обновления, резервные копии,
  восстановление и откат неудачного обновления вместе с данными.
- Шифрование и автообновление включены по умолчанию в мастере. Один ответ
  управляет обновлением Server и Manager; настройки канала для них нет.
- Генераторы ключей и клиент показывают секрет участников и отдельный публичный
  SHA-256 key ID для сервера без строк `.env`. Секрет участника нельзя передавать серверу.

Сначала выпускается переходный клиент `v0.8.1` из неизменного коммита `3747a0d`,
затем `server-v0.9.0`, `manager-v0.1.0` и `client-v0.9.0`. Для установленного 0.8.0
сохраняется путь обновления через bridge с обычным подтверждением пользователя.
Client, Server и Manager используют независимые версии и подписи.

Branch CI проверил Linux amd64/arm64, настоящие systemd/SCM-службы и Windows
Server 2022/2025 EXE-установку с удалением и сохранением данных. Голос проверяется
настоящими Electron/LiveKit-клиентами с синтетическим аудио. Физические микрофоны,
разные внешние сети, Windows 10/11 и Server 2019 отдельно не проверялись.
Фаервол/роутер настраиваются владельцем; установка не устраняет CGNAT.

Автообновление Server прерывает звонок; обновление только кода Manager его не
перезапускает. Замена встроенного Python/SCM launcher требует повторной установки
Manager EXE. Удаление сохраняет данные и настройки; межплатформенный перенос
резервных копий Linux ↔ Windows не заявлен.

## English

- **Client 0.9.0:** independent `client-v*` updates, legacy Server 0.8.0 API
  compatibility and preserved temporary Windows rooms. The update button sits
  above Settings in the sidebar without moving page content.
- **Server 0.9.0:** permanent Linux hosting with Docker Compose on amd64/arm64,
  and native Windows x64 Go/LiveKit hosting. Both use the same server core and
  maintenance controller; Windows requires neither Docker nor WSL.
- **Manager 0.1.0:** bilingual setup and a Windows EXE with embedded Python,
  system services, signed independent updates, consistent backups, restore and
  rollback of both server version and data after a failed update.
- The wizard defaults encryption and automatic updates to yes. One answer controls
  Server/Manager updates, with no channel setting for either component.
- Key generators and the client show the participant secret separately from the
  public SHA-256 server key ID, without `.env` assignments. Never give the server
  the participant secret.

Publish the `v0.8.1` bridge from immutable commit `3747a0d` first, followed by
`server-v0.9.0`, `manager-v0.1.0` and `client-v0.9.0`. Existing 0.8.0 clients can
discover the bridge and then the new Client family with normal user confirmation.
Components have independent versions and signing keys.

Branch CI covers Linux amd64/arm64, real systemd/SCM services and Windows Server
2022/2025 EXE install/uninstall with data retention. Voice uses real Electron/LiveKit
clients with synthetic audio. Physical microphones, separate external networks,
Windows 10/11 and Server 2019 remain unverified. Owners configure firewall/router
rules; installation does not resolve CGNAT.

Server updates interrupt calls; Manager policy-code updates do not restart the
server. Updating embedded Python or the stable SCM launcher requires reinstalling
the Manager EXE. Uninstall retains data/configuration. Cross-OS Linux ↔ Windows
backup migration is not supported.
