# Application language and updates / Язык и обновления

The updater was introduced in 0.2.0. PawTalk 0.7.1 is the current public preview. Clients on 0.6.0 and 0.7.0 must install 0.7.1 manually because they cannot discover the repository-name capitalization fix; preferences remain intact.
Обновлятор появился в 0.2.0. Актуальный предварительный выпуск — PawTalk 0.7.1. Клиентам 0.6.0 и 0.7.0 нужно установить 0.7.1 вручную: эти версии не находят исправление сравнения регистра имени репозитория. Настройки сохраняются.

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

Комнаты передают установщик потоком без записи на диск. Маленькие метаданные
кешируются в памяти на минуту. Лимиты сервера: две передачи одновременно,
до 1 МиБ/с на установщик, 20 запросов в минуту с IP. `PAWTALK_UPDATE_PROXY=false`
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

Rooms stream installer bytes without writing them to disk. Metadata is cached in
memory for one minute. Limits: two upstream requests at once, 1 MiB/s per installer,
20 requests per minute per IP. Set `PAWTALK_UPDATE_PROXY=false` in the server
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

References: [NSIS integration](https://www.electron.build/v26/docs/nsis/),
[GitHub release API and asset digests](https://docs.github.com/en/rest/releases/releases).
