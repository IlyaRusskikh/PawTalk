# Planned Client 0.10.0 / Server 0.10.0 / Manager 0.2.0

Статус: **подготовка в ветке `0.10.0`, не опубликовано**. Ветки CI не являются
проверками release tags. Merge и теги выполняются отдельно после принятия CI.

## Русский

- **Client 0.10.0:** корректный разбор приглашения и отдельного пароля из старого
  Manager, запрос недостающего E2EE-ключа, LAN-подключение через проверенный `/rtc`.
  Проверенные комнаты объединяются в одну закладку независимо от текста ссылки
  и пароля. Закладка с устаревшим доступом не раскрывает активность и просит вход.
- **Server 0.10.0:** счётчик, участники и непрочитанное требуют текущей авторизации.
  Сброс пароля native-сервера отзывает старые голосовые/чат/preview токены.
  Новая команда `serve rebind` меняет IP и сертификат с сохранением пароля и истории.
- **Manager 0.2.0:** Windows-трей, ярлыки и серверный значок; окно текущих настроек
  с резервной копией, проверенным перезапуском и откатом. Защищённый общий
  ProgramData вместо Program Files; миграция старой установки. Повторная установка
  использует существующий конфиг; деинсталлятор предлагает удалить данные.
  Приглашение с паролем показывается один раз и защищается пользовательским DPAPI.
  Загрузка подписанных выпусков повторяется при временных сетевых ошибках.

Порядок после отдельного разрешения: `server-v0.10.0` → `manager-v0.2.0` →
`client-v0.10.0`. Каждая линия проходит собственный tag workflow. Исторические
теги и опубликованные assets не заменяются. До публикации действуют прежние
ссылки загрузки. На уже установленном сервере защита не включается от одного
обновления клиента или пересборки Manager; нужен обновлённый подписанный Server.
Смена IP/порта требует нового приглашения и проверки проброса/брандмауэра.
E2EE-секрет не восстанавливается из key ID и передаётся участникам отдельно.

## English

Status: **development on `0.10.0`, unpublished**. Branch CI does not replace
release-tag verification. Merge and component tags remain separate later steps.

- **Client 0.10.0:** legacy Manager invitation/password paste, missing E2EE-key
  prompts and authenticated LAN `/rtc` routing. Verified rooms deduplicate across
  invitations/password changes. Locked bookmarks disclose no room activity.
- **Server 0.10.0:** current authorization for occupancy, participants and unread
  counts; native password reset revokes previous voice/chat/preview tokens.
  `serve rebind` changes IP/certificate while preserving password and history.
- **Manager 0.2.0:** native Windows tray, shortcuts/server badge, current-settings
  window with backup/health verification/rollback, protected ProgramData migration,
  config reuse and optional full-data uninstall. Password invitations appear once
  and use user DPAPI; signed-release downloads retry transient network failures.

After separate approval, publish Server first, then Manager, then Client using
`server-v0.10.0`, `manager-v0.2.0`, `client-v0.10.0`. Do not replace historical
tags/assets or update download links before publication. Installed servers require
an actual signed Server upgrade for privacy enforcement; rebuilding Manager or
updating Client alone does not change the running binary. IP/port changes require
new invitations and network-rule checks. Share the E2EE secret separately from its
key ID. The embedded temporary-room API retains its pinned historical source plus
the hash-pinned security backport in `bundled-server.json`.
