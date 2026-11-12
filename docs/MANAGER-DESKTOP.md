# Server Manager 0.3.0 desktop

Подготовка, ещё не опубликовано / In preparation, not yet published.
Published downloads remain linked from [Windows Server](WINDOWS-SERVER.md).

## Русский

Manager использует отдельное окно Electron/React. Оно содержит состояние службы,
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

Manager has a dedicated Electron/React window for service status, password and
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

Before release, use a clean elevated Windows VM for actual SCM install/upgrade,
SYSTEM scheduled installer, login autostart and uninstall. These require an
administrator session; console or mocked-scheduler success does not establish
that they passed. Do not run the installer smoke over a user's existing server.
Physical audio devices, external Internet reachability and other CPU platforms
require separate verification.

Перед выпуском в чистой Windows VM с правами администратора проверяются настоящие
SCM install/upgrade, установка задачей SYSTEM, автозапуск при входе и удаление.
Console smoke и подменённый планировщик не заменяют эти проверки. Не запускайте
installer smoke поверх существующего сервера пользователя. Физические аудиоустройства,
внешняя сеть и другие процессорные платформы проверяются отдельно.
