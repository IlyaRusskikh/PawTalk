# Client 0.10.0 / Server 0.10.1 / Manager 0.2.0 — 2026-11-12

Server 0.10.0 tag verification stopped before publication: the server-only
Electron harness incorrectly depended on Client `dist`. The tag remains unchanged;
Server 0.10.1 carries the isolated-harness fix and passed its own release verification.

Статус: **опубликованы предварительные выпуски**. Branch CI, отдельные component
проверки и все три release-tag workflow прошли; подписи и хэши скачанных assets проверены.

- [Server 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.10.1) · [CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43137302074)
- [Manager 0.2.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.0) · [CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43143103343)
- [Client 0.10.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.10.0) · [CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43143215176)

## Русский

- **Client 0.10.0:** корректный разбор приглашения и отдельного пароля из старого
  Manager, запрос недостающего E2EE-ключа, LAN-подключение через проверенный `/rtc`.
  Проверенные комнаты объединяются в одну закладку независимо от текста ссылки
  и пароля. Закладка с устаревшим доступом не раскрывает активность и просит вход.
- **Server 0.10.1:** счётчик, участники и непрочитанное требуют текущей авторизации.
  Сброс пароля native-сервера отзывает старые голосовые/чат/preview токены.
  Новая команда `serve rebind` меняет IP и сертификат с сохранением пароля и истории.
- **Manager 0.2.0:** Windows-трей, ярлыки и серверный значок; окно текущих настроек
  с резервной копией, проверенным перезапуском и откатом. Защищённый общий
  ProgramData вместо Program Files; миграция старой установки. Повторная установка
  использует существующий конфиг; деинсталлятор предлагает удалить данные.
  Приглашение с паролем показывается один раз и защищается пользовательским DPAPI.
  Загрузка подписанных выпусков повторяется при временных сетевых ошибках.

Сначала опубликован `server-v0.10.1`; затем `manager-v0.2.0` и `client-v0.10.0`
выпущены параллельно из одного проверенного коммита. Каждая линия прошла собственный
tag workflow. Исторические теги и опубликованные assets не заменяются.
На уже установленном сервере защита не включается от одного
обновления клиента или пересборки Manager; нужен обновлённый подписанный Server.
Смена IP/порта требует нового приглашения и проверки проброса/брандмауэра.
E2EE-секрет не восстанавливается из key ID и передаётся участникам отдельно.
Переустановка Manager сохраняет версию установленного Server. Для обновления
выполните `pawtalkctl update now` с правами администратора; [команды Windows](WINDOWS-SERVER.md).

## English

Status: **published previews**. Branch, isolated component and all three release-tag
workflows passed; downloaded release signatures and hashes were verified.

- **Client 0.10.0:** legacy Manager invitation/password paste, missing E2EE-key
  prompts and authenticated LAN `/rtc` routing. Verified rooms deduplicate across
  invitations/password changes. Locked bookmarks disclose no room activity.
- **Server 0.10.1:** current authorization for occupancy, participants and unread
  counts; native password reset revokes previous voice/chat/preview tokens.
  `serve rebind` changes IP/certificate while preserving password and history.
- **Manager 0.2.0:** native Windows tray, shortcuts/server badge, current-settings
  window with backup/health verification/rollback, protected ProgramData migration,
  config reuse and optional full-data uninstall. Password invitations appear once
  and use user DPAPI; signed-release downloads retry transient network failures.

Server was published first; `manager-v0.2.0` and `client-v0.10.0` then ran in parallel
from the same verified commit. Do not replace historical tags/assets. Installed servers require
an actual signed Server upgrade for privacy enforcement; rebuilding Manager or
updating Client alone does not change the running binary. IP/port changes require
new invitations and network-rule checks. Share the E2EE secret separately from its
key ID. The embedded temporary-room API retains its pinned historical source plus
the hash-pinned security backport in `bundled-server.json`.
Reinstalling Manager preserves the installed Server version. Run `pawtalkctl update now`
with administrative privileges to upgrade it; see the [Windows commands](WINDOWS-SERVER.md).
