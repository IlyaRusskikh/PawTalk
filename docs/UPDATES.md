# Application language and updates / Язык и обновления

PawTalk 0.7.1 is the current public preview. For update fixes in previous releases, see the [changelog](../CHANGELOG.md).
Актуальный предварительный выпуск — PawTalk 0.7.1. Исправления обновлятора в прошлых выпусках описаны в [CHANGELOG](../CHANGELOG.md).

## Русский

Установщик предлагает English или Русский. Выбор применяется к установщику и
первому запуску приложения. Его можно изменить в «Настройки → Язык» без перезапуска. При обновлении сохраняется язык профиля пользователя.

Установленное Windows-приложение при запуске проверяет публичные релизы
`IlyaRusskikh/pawtalk` через GitHub API, включая pre-release. Выбирается наибольшая
версия выше текущей по порядку SemVer; черновики и релизы без подходящего
Windows x64 установщика и SHA-256 пропускаются. Проверяются до 1000 последних
релизов. API может ограничить частоту запросов; ошибки проверки не мешают запуску.
В режиме разработки проверка не выполняется.

Предложение ждёт закрытия открытой модалки. «Отложить» скрывает его до следующего
запуска, оставляя иконку справа сверху на основных экранах. Нажмите её, чтобы
снова открыть предложение. При открытых модалках иконка скрыта. До нажатия
«Загрузить и установить» установщик не скачивается.

При установке:

1. Сведения о релизе и подписанный `update-manifest.json` запрашиваются сначала
   у GitHub, при сетевой ошибке — через комнаты из избранного в сохранённом порядке.
   Клиент проверяет Ed25519-подпись встроенным публичным ключом, срок действия,
   версию, имя, размер и SHA-256. Затем установщик загружается в `userData/updates`
   сначала с GitHub, при ошибке или низкой скорости — через комнаты. До успешной
   проверки всех байтов текущая версия не затрагивается.
2. Запускается скрытый PowerShell-помощник из этой же папки. Приложение завершает
   звонок, останавливает встроенный сервер и закрывается. В модалке заранее
   показано предупреждение о прерывании звонка или отключении гостей.
3. Приложение сначала ждёт подтверждения готовности помощника. Его отдельное
   окно показывает этап и прошедшее время даже после закрытия PawTalk.
   Помощник ждёт завершения процесса, затем запускает NSIS с `/S --updated
   --force-run`. Штатный NSIS-скрипт сначала вызывает деинсталлятор предыдущей
   версии, затем устанавливает новую в ту же папку и запускает её.
4. Профиль, настройки, язык, закладки и защищённые пароли сохраняются. Установщик
   удаляется из кеша после успеха. Ошибка установки показывается отдельным окном
   и записывается в `userData/updates/update-helper.log` (ошибки запуска —
   `update-launch.log`); скачанный EXE остаётся
   для ручного повторного запуска. При установке для всех пользователей Windows
   может запросить повышение прав.

Манифест подписан отдельно от EXE; подписи Windows Authenticode у установщика
пока нет. Клиент не принимает неподписанные обновления. Старые клиенты сохраняют
прежний механизм проверки до обновления самого клиента. Автоматический откат
после ошибки установки не реализован.

Поддерживаются и встроенные self-host комнаты Windows, и серверы на VPS:
добавьте комнату в закладки, оставьте её запущенной и обеспечьте серверу доступ
к GitHub. Для self-host используется актуальное приглашение с TLS-отпечатком.
Клиенту прямой доступ к GitHub при этом не нужен.

При первой загрузке комната передаёт установщик потоком и записывает его во
временный файл. Только полная успешная передача попадает в дисковый кэш;
обрыв или ошибка не заменяют прежний установщик. Повторная загрузка того же
EXE идёт с диска без запроса установщика к GitHub. Одновременно выполняется
одно заполнение кэша; второй запрос использует результат первого после его
завершения. При успешной загрузке более новой версии старый EXE автоматически
удаляется. Запрос старой версии не вытесняет новую из кэша.

Кэш сохраняется после перезапуска сервера и пересоздания self-host комнаты:
на Windows это `%LOCALAPPDATA%\PawTalk\update-relay`, на VPS Swarm —
`update-cache/` внутри постоянного каталога `PAWTALK_DATA_DIR` (обычно `/data`).
Каталог кэша предназначен для одного процесса сервера. Хранится один завершённый
EXE размером до 1 ГиБ; во время замены дополнительно нужен объём нового файла.
После аварийного завершения оставшиеся временные и старые файлы очищаются при
следующем запуске. Клиент по-прежнему проверяет подпись, размер и SHA-256.

Маленькие метаданные кешируются в памяти на минуту, затем снова запрашиваются
с GitHub. Ограничения скорости передачи установщика на сервере нет. Остаются
лимиты: две передачи одновременно, 20 запросов в минуту с IP. `PAWTALK_UPDATE_PROXY=false`
отключает прокси; для Docker передайте переменную в окружение контейнера.
Прокси работает только с релизами PawTalk и проверяет перенаправления GitHub.
Пароль комнаты и ключ E2EE для публичной раздачи обновления не передаются.

Клиент переключает источник при отсутствии данных 20 секунд или скорости ниже
64 КиБ/с за 30 секунд. Каждый источник скачивается заново; докачки пока нет.
Общий таймаут одной попытки — 15 минут. Недоступные комнаты и старые серверы
пропускаются. Несовпадение подписи или хеша останавливает установку: сообщение
указывает источник и предлагает ручную загрузку через VPN. Сетевой обрыв сам по
себе не называется подменой. Сохраняется наибольшая проверенная предложенная
версия, манифест действует 365 дней. Это ограничивает откат, но посредник всё ещё
может скрыть наличие обновления; свежесть требует доступного честного источника.

### Ручное обновление Windows

1. Скачайте `PawTalk.Setup.X.Y.Z.exe` из нужного GitHub Release; при необходимости включите VPN.
2. Полностью завершите PawTalk через «Выйти» в трее. Звонок и ваша комната остановятся.
3. Запустите скачанный EXE. Оставьте прежнюю папку и тот же вариант установки
   (для текущего пользователя либо для всех пользователей).
4. Завершите установку и откройте PawTalk. **Удалять старую версию вручную не нужно:**
   установщик сам выполняет замену, сохраняя настройки, закладки и пароли профиля
   того же пользователя Windows. Не удаляйте папку пользовательских данных.

## English

The installer offers English and Russian. Its choice is used on the first app
launch; change it later in **Settings → Language** without a
restart. Updates preserve the profile's language.

At startup, the installed Windows app checks public GitHub releases, including
pre-releases, and offers the highest SemVer version above the current one.
Drafts and releases without a matching Windows x64 installer and GitHub SHA-256
digest are skipped. Up to 1000 recent releases are checked. Offline/API failures
do not interrupt startup; development builds do not check.

The offer waits for existing dialogs to close. **Later** defers it for the current
launch and leaves an icon at the top right of the main screens. It is hidden
while dialogs are open. Click it to reopen the offer. Nothing is downloaded
until **Download and install** is selected.

Release metadata and the signed `update-manifest.json` are fetched directly from
GitHub first, then through favorite rooms on network failure. The client verifies
Ed25519 using its embedded public key, freshness and artifact bindings. Installer
downloads independently try GitHub first, then favorite rooms on errors, 20 seconds
without data, or less than 64 KiB/s over a 30-second window. Each source restarts
the download; resume is not implemented. Each attempt has a 15-minute limit.
The complete installer is downloaded into `userData/updates` and its signed size and
SHA-256 are verified before exiting. A hidden PowerShell helper waits for the
app and hosted room to shut down, then starts NSIS with `/S --updated --force-run`
in the existing install directory. NSIS invokes the old uninstaller, installs
the replacement and launches it. Profile, language, settings, bookmarks and
stored passwords remain. The dialog warns about interrupting a call or closing
the hosted room. Per-machine installations may require Windows elevation.

The app waits for a fresh helper readiness token before closing. A separate
progress window shows shutdown, installation, startup and elapsed time. The helper
waits for the installer process rather than its entire process tree, confirms the
new app has loaded, and retries launching it if the installer did not start it.

On installation failure the window and `userData/updates/update-helper.log`
report the error (`update-launch.log` records helper launch failures); the downloaded installer remains for a manual retry. Successful
installation removes the cached EXE. There is no automatic rollback after an
installation failure. The manifest has an independent signature; Windows
Authenticode signing is not enabled. New clients require signed manifests;
older clients keep their previous updater until upgraded.

Both built-in Windows self-host rooms and VPS servers support this relay. Bookmark
the room, keep it running and allow the server to reach GitHub. Self-host rooms
require a current invitation with its TLS fingerprint. The client does not need
direct GitHub access.

On the first download, rooms stream installer bytes and write a temporary file.
Only a complete successful transfer is committed to the disk cache. A failed or
interrupted transfer preserves the previous installer. Repeat downloads of that
EXE use disk without fetching the installer from GitHub again. One cache fill
runs at a time; a second request reuses its result after completion. A successfully
downloaded newer version automatically removes the older EXE. Requests for older
versions do not evict a newer cached version.

The cache survives server restarts and self-host room recreation. Windows uses
`%LOCALAPPDATA%\PawTalk\update-relay`; Swarm VPS servers use `update-cache/` inside
the persistent `PAWTALK_DATA_DIR` (normally `/data`). Each cache directory belongs
to one server process. It holds one completed EXE up to 1 GiB; a replacement
temporarily needs space for the new file as well. Orphaned temporary and old files
are cleaned up on the next startup after a crash. Clients still verify the signed
manifest, installer size and SHA-256.

Metadata is cached in memory for one minute, then fetched from GitHub again.
Installer transfers have no server bandwidth cap. Limits remain: two concurrent
transfers and 20 requests per minute per IP. Set `PAWTALK_UPDATE_PROXY=false` in the server
process/container environment to disable the relay. Only PawTalk release
resources and approved GitHub redirects are accepted. Room passwords and E2EE
keys are never sent to the update relay. Broken connections try another source;
invalid signatures or checksums stop installation with the source name and advice
to download manually using a VPN. Signed manifests expire after 365 days and the
highest authenticated offered version is remembered to restrict rollback. Relays
can still hide updates; availability requires an accessible honest source.

### Manual Windows upgrade

Download the release EXE (use a VPN if needed), completely exit PawTalk from its
tray menu, then run the new installer using the existing directory and installation
scope (current user or all users). Finish installation and reopen PawTalk.
**Do not uninstall the old version manually.** NSIS replaces it and preserves the
same Windows user's profile, settings, bookmarks and saved passwords. Calls and
hosted rooms stop during the upgrade. Do not delete the user-data directory.

## Maintainers

Attach `PawTalk.Setup.X.Y.Z.exe` and `update-manifest.json`
to the matching `vX.Y.Z` release. Keep its SHA-256
digest exposed by GitHub and attach `SHA256SUMS.txt` as documented in
[RELEASING.md](RELEASING.md). Never replace published assets. The updater uses
the repository pinned in `electron/updater.cjs`; forks must change that constant.
Only package an x64 build under this asset name. No release is published by a
local build. See [UPDATE-SIGNING.md](UPDATE-SIGNING.md) for key setup and signing.

Checks: `npm run build`, `npm test`, `node scripts/updates-ui-smoke.mjs`,
`node scripts/ui-flow-smoke.mjs --built`, and an NSIS build. UI/update tests use
synthetic data and never execute a downloaded binary. A real upgrade between
two separately versioned releases, UAC and recovery after installer failure
still require an isolated Windows acceptance check.

For an opt-in live relay check on Windows, run `npm run server:prepare`, then
`node scripts/update-relay-smoke.mjs`. This starts the actual embedded room on
ports 31443–31446 (including its normal router-mapping attempt), blocks direct
client GitHub access, checks LAN and owner-loopback update discovery, downloads
the published installer through the relay and verifies its signed size/SHA-256.
It also rejects a stale invitation fingerprint. The downloaded EXE is deleted
without execution. This single-machine check does not verify access from another
device or through an external network; it is separate from synthetic unit tests
and is not an offline CI requirement.
Use `node scripts/update-relay-smoke.mjs --metadata-only` to check discovery,
signatures and invitation handling without downloading the installer.

References: [NSIS integration](https://www.electron.build/v26/docs/nsis/),
[GitHub release API and asset digests](https://docs.github.com/en/rest/releases/releases).
