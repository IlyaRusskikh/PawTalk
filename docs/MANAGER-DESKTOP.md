# Server Manager 0.4.0 desktop

Опубликован preview / Published preview: [Manager 0.4.0](releases/manager-v0.4.0.md). Предыдущий выпуск / Previous release: [Manager 0.3.0](releases/manager-v0.3.0.md).
Downloads and installation: [Windows Server](WINDOWS-SERVER.md).

## Русский

Manager использует отдельное окно Electron/React. Первый двойной клик по трею и первая команда «Открыть настройки» показывают уже отрисованное окно; процесс GUI запускается без принудительного SW_HIDE. Оно содержит состояние службы,
копирование пароля и приглашения, сеть, E2EE, историю, обновления, резервные копии
и диагностику. Секреты копируются непосредственно в системный буфер обмена и не
попадают в снимок настроек или текст страницы. Сброс пароля требует подтверждения.

Трей показывает реальное состояние службы Windows: зелёный — работает, жёлтый —
запускается или останавливается, красный — остановлена. Если состояние недоступно,
это явно указано в меню. Меню содержит статус, запуск/остановку, настройки,
выход и скрытие; при отключённой автоматической установке появляется доступное
обновление. «Выйти из менеджера» сначала останавливает сервер. «Скрыть менеджер»
убирает только значок; процесс продолжает работу. Повторный запуск возвращает
значок и окно. Закрытие окна оставляет Manager в фоне.

Сохранение настроек сохраняет остановленное состояние сервера. Следующий запуск
использует новые настройки. Работающий сервер перезапускается только при
необходимости; изменение сети/E2EE/истории требует подтверждения. Конфликт с
изменениями другого окна требует повторной загрузки настроек. Операции ограничены
по времени; окно можно скрыть во время их выполнения. Резервное копирование,
восстановление и обновление Server также сохраняют остановленное состояние.

Служба Manager проверяет обновления при запуске и каждые десять минут, включая
режим с отключённой автоматической установкой. Запуск обычного трея отправляет
службе сигнал проверки без запроса UAC. При включённом автообновлении полный
Windows-установщик Manager из подписанного манифеста загружается, проверяется по размеру и SHA-256
и запускается отдельной задачей SYSTEM без дополнительного подтверждения.
Установка может прервать текущий звонок. При выключенном автообновлении установка
запускается через меню или окно. Подпись метаданных, допустимая версия и хеш
проверяются до запуска установщика; повторная постановка той же установки
ограничена. Обновление не заменяет опубликованные файлы старого релиза.

Обычное окно работает без прав администратора. Первое защищённое действие,
включая загрузку конфигурации, запрашивает UAC для отдельного Go-посредника.
Renderer изолирован и получает только ограниченный API. Служебные команды Windows
используют Python-контроллер из защищённого каталога установленного Manager,
чтобы старый выбранный bundle не возвращал прежнюю логику. Полный Windows
установщик обновляет окно, Go host и контроллер совместно. Linux продолжает
использовать существующую схему подписанных bundles.

## English

The first tray double-click or Settings command shows the rendered window. GUI startup does not force SW_HIDE over its first show. Manager has a dedicated Electron/React window for service status, password and
invitation copying, networking, E2EE, history, updates, backups and diagnostics.
Secrets go directly to the system clipboard, never into the settings snapshot
or page text. Password reset requires confirmation.

The tray reflects actual Windows service status: green for running, yellow for
starting/stopping and red for stopped. Unavailable status is explicitly labelled.
Its menu contains status, start/stop, settings, exit and hide, plus an available
update when automatic installation is disabled. Exit stops the server before
closing Manager. Hide removes only the icon and leaves the process running.
Launching Manager again restores the icon and window. Closing the window leaves
Manager running in the background.

Saving settings preserves a stopped server; the next start uses the new settings.
A running server restarts only when necessary, with confirmation for changes to
networking, E2EE or history. Concurrent configuration changes require a reload.
Operations have time limits and the window can be hidden while they run. Backup,
restore and Server updates also preserve the stopped state.

The Manager service checks for updates at startup and every ten minutes, even
when automatic installation is disabled. Ordinary tray startup signals a check
without UAC. With automatic updates enabled, the complete Windows Manager
installer from signed metadata is downloaded, checked against its declared size and SHA-256, and run
by a separate SYSTEM scheduled task without another confirmation. Installation
may interrupt a call. Otherwise installation is available from the tray/window.
Metadata signatures, allowed versions and hashes are checked before execution;
duplicate scheduling of the same installation is limited. Published older release
files remain immutable.

The window runs without administrator privileges. Its first protected operation,
including configuration retrieval, requests UAC for a separate Go broker. The
renderer is isolated and receives a limited API. Windows service commands use
the controller shipped in the protected installation directory so an older
selected bundle cannot restore obsolete behavior. The complete Windows installer
updates the window, Go host and controller together. Linux retains its existing
signed-bundle update mechanism.

## Local Server packages / Локальные пакеты Server

Available in Manager 0.4.0 / Доступно в Manager 0.4.0.

**Удаление копий / Delete backups.** В разделе «Резервные копии» у каждой записи
есть «Удалить». Подтверждение показывает дату и имя выбранной копии. После
удаления список обновляется сразу, без перезапуска сервера. Копия, нужная для
незавершённого восстановления, не удаляется; выход за каталог копий и ссылки
внутри него отклоняются. / Each backup has a Delete action with its date/name
shown for confirmation. The list updates immediately without restarting Server.
Backups needed for pending recovery cannot be deleted; paths outside the backup
directory and nested links are rejected.

**RU.** На вкладке «Обновления» Server сначала проверяется, затем предлагается
установка найденной версии. Ручная проверка Manager не включает автоустановку.
Сеть не удерживает блокировку комнаты; индикатор проверки остаётся на своей
вкладке. Настройки, журнал и диагностика читаются во время обслуживания.
Приглашение копируется в «Обзоре»; установщик больше не показывает его.

«Установить из файла…» принимает `PawTalk.Server.X.Y.Z.windows-x64.zip` или
`PawTalk.Server.X.Y.Z.pawtalk-server.zip`. Для скачанного вручную релиза положите
его `server-manifest.json` рядом с обычным ZIP либо включите его в переносимый
пакет. Подпись проверяется установленными корнями доверия, а размер и SHA-256
должны совпасть. Повреждённая/неверная подпись не заменяется режимом без подписи.

Без манифеста пакет считается локальной сборкой: Manager явно предупреждает,
что подпись опубликованного выпуска не подтверждена, и требует подтверждения
перед исполнением. До подтверждения архив только проверяется и копируется в
защищённый каталог; код из него не запускается. Проверка целостности не
подтверждает автора. Устанавливайте только доверенные локальные сборки.
Версия и SHA-256 показаны в подтверждении. Повторная сборка с тем же номером
хранится в отдельном каталоге; опубликованные бинарники не заменяются. Автообновление Server выключается после успешной установки локальной сборки, чтобы фоновая служба не заменила её опубликованным релизом. Его можно включить обратно в UI.

Перед установкой создаётся копия комнаты; неудачный запуск откатывает данные и
бинарники. Остановленный Server остаётся остановленным. Локальные резервные
копии можно восстановить через UI этого Manager; перенос такой копии в новую
установку через CLI пока не поддержан. Сохраните исходный пакет. Работа с пакетом
после его скачивания не требует GitHub; первоначальная установка самого Manager
по-прежнему использует опубликованные подписанные зависимости.

**EN.** On Updates, Server availability is checked before an installation is
offered. Manual Manager checks never trigger installation. Metadata requests do
not hold the room lock and progress stays on Updates. Settings, logs and
diagnostics remain readable during maintenance. Invitations are copied in
Overview; the installer no longer displays them.

Install from file accepts the regular Windows Server ZIP or the portable package
named above. Include the release's `server-manifest.json` beside the regular ZIP
or inside the portable package to verify it using existing trust roots, exact
size and SHA-256. Invalid signatures never fall back to unsigned installation.
Without a manifest, the UI identifies a local build and requires explicit
approval. Inspection only validates and privately stages bytes; it never runs
the package. Checksums establish integrity, not authorship. Only approve local
code you trust. Same-version local builds have separate directories and do not
replace published binaries. Successful local installation disables Server auto-updates so background maintenance does not replace the test build; re-enable them in the UI when desired. Installation backs up the room, preserves stopped
state and rolls back failed starts. Local-build backups can be restored in this
Manager's UI; fresh-install CLI migration is not supported yet. Keep the original
package. Package installation needs no GitHub connection, while initial Manager
setup still needs its signed published dependencies.

The Windows Server build also creates a portable package. To package an existing
archive manually / Сборка Windows Server создаёт переносимый пакет. Для уже
готового архива:

```powershell
node scripts/package-local-server.mjs --archive release/server/PawTalk.Server.0.10.1.windows-x64.zip
# Optional signed release metadata / Необязательный подписанный манифест:
node scripts/package-local-server.mjs --archive release/server/PawTalk.Server.0.10.1.windows-x64.zip --manifest release/server/server-manifest.json
```

The outer ZIP contains `package.json` and `server.zip`, optionally
`server-manifest.json`. Metadata format is `pawtalk-server-package-v1` with
`version`, `apiProtocol: 1`, `dataSchema: 1` and the inner ZIP's `sha256`.
The regular ZIP retains its existing seven-file allowlist and license notices.

## Build and verification / Сборка и проверка

From the repository root / Из корня репозитория:

```powershell
node scripts/build-manager-windows.mjs
node scripts/manager-desktop-smoke.mjs
node scripts/manager-packaged-smoke.mjs
node --test tests/manager-tray.test.mjs
node scripts/windows-manager-smoke.mjs
npm run check:public
```

The build uses the repository's locked Electron/React dependencies and never
publishes. Generated desktop assets and installer output are ignored by Git.
`--runtime-only` builds the Go/Python runtime without the desktop installer.

Сборка использует закреплённые зависимости Electron/React и ничего не публикует.
Сгенерированные ресурсы и установщик исключены из Git. `--runtime-only` собирает
только Go/Python runtime.

The desktop smoke checks actual Electron rendering in Russian/English with
normal/reduced motion, conditional field spacing, modal buttons, stopped saves,
conflicts and navigation during operations. Its management API is synthetic.
The separate tray smoke uses actual Electron Tray/Menu APIs and all three icons.
The Windows console integration exercises real Go/LiveKit, DPAPI, SQLite and
two Electron clients with synthetic audio; its service adapter does not register
services with SCM.

Проверка интерфейса использует настоящий Electron, русский/английский язык,
обычную/уменьшенную анимацию, геометрию полей и кнопок, сохранение при остановке,
конфликты и навигацию во время операции; API управления в ней синтетический.
Отдельная проверка трея использует реальные Tray/Menu и три значка. Windows
console integration использует реальные Go/LiveKit, DPAPI, SQLite и два Electron
клиента с синтетическим звуком, но не регистрирует службы SCM.

The 0.3.0 branch CI passed actual SCM services and NSIS install/reinstall/uninstall
on Windows 2022/2025, plus Linux amd64/arm64 Compose lifecycle. Unattended SYSTEM
installation and login autostart still require separate acceptance in a clean
elevated Windows VM; console or mocked-scheduler success does not establish them.
Do not run installer smoke over a user's existing server. Physical audio devices,
external Internet reachability and load require separate verification.

Branch CI 0.3.0 проверил настоящие SCM-службы и NSIS install/reinstall/uninstall
на Windows 2022/2025, а также Compose lifecycle на Linux amd64/arm64. Автоматическая
установка задачей SYSTEM и автозапуск при входе ещё требуют отдельной приёмки в
чистой Windows VM с правами администратора; console smoke и подменённый планировщик
их не заменяют. Не запускайте installer smoke поверх существующего сервера
пользователя. Физические аудиоустройства, внешняя сеть и нагрузка проверяются отдельно.
