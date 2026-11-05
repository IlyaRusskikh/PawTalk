# Application language and updates / Язык и обновления

Available starting with Voicecord 0.2.0. Published 0.1.0 needs one manual upgrade.
Доступно с Voicecord 0.2.0. С версии 0.1.0 нужно один раз обновиться вручную.

## Русский

Установщик предлагает English или Русский. Выбор применяется к установщику и
первому запуску приложения. Его можно изменить в «Настройки → Обо мне → Язык
приложения» без перезапуска. При обновлении сохраняется язык профиля пользователя.

Установленное Windows-приложение при запуске проверяет публичные релизы
`IlyaRusskikh/voicecord` через GitHub API, включая pre-release. Выбирается наибольшая
версия выше текущей по порядку SemVer; черновики и релизы без подходящего
Windows x64 установщика и SHA-256 пропускаются. Проверяются до 1000 последних
релизов. API может ограничить частоту запросов; ошибки проверки не мешают запуску.
В режиме разработки проверка не выполняется.

Предложение ждёт закрытия открытой модалки. «Отложить» скрывает его до следующего
запуска, оставляя иконку справа сверху на основных экранах. Нажмите её, чтобы
снова открыть предложение. При открытых модалках иконка скрыта. До нажатия
«Загрузить и установить» установщик не скачивается.

При установке:

1. Установщик загружается в `userData/updates`, размер и SHA-256 сверяются с
   метаданными GitHub. До успешной проверки текущая версия не затрагивается.
2. Запускается скрытый PowerShell-помощник из этой же папки. Приложение завершает
   звонок, останавливает встроенный сервер и закрывается. В модалке заранее
   показано предупреждение о прерывании звонка или отключении гостей.
3. Приложение сначала ждёт подтверждения готовности помощника. Его отдельное
   окно показывает этап и прошедшее время даже после закрытия Voicecord.
   Помощник ждёт завершения процесса, затем запускает NSIS с `/S --updated
   --force-run`. Штатный NSIS-скрипт сначала вызывает деинсталлятор предыдущей
   версии, затем устанавливает новую в ту же папку и запускает её.
4. Профиль, настройки, язык, закладки и защищённые пароли сохраняются. Установщик
   удаляется из кеша после успеха. Ошибка установки показывается отдельным окном
   и записывается в `userData/updates/update-helper.log` (ошибки запуска —
   `update-launch.log`); скачанный EXE остаётся
   для ручного повторного запуска. При установке для всех пользователей Windows
   может запросить повышение прав.

Установщики пока не подписаны. SHA-256 подтверждает соответствие файлу в
GitHub Release, а не независимую подпись автора. Автоматический откат после
ошибки установки не реализован. Уже опубликованную 0.1.0 нужно один раз обновить
вручную до версии с этим механизмом.

## English

The installer offers English and Russian. Its choice is used on the first app
launch; change it later in **Settings → About me → App language** without a
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

The complete installer is downloaded into `userData/updates` and its size and
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
installation failure. Installers remain unsigned; the digest verifies the
GitHub asset, not an independent author signature. Published 0.1.0 needs one
manual upgrade to a version containing this updater.

## Maintainers

Attach `Voicecord.Setup.X.Y.Z.exe` (GitHub-normalized name) or
`Voicecord Setup X.Y.Z.exe` to the matching `vX.Y.Z` release. Keep its SHA-256
digest exposed by GitHub and attach `SHA256SUMS.txt` as documented in
[RELEASING.md](RELEASING.md). Never replace published assets. The updater uses
the repository pinned in `electron/updater.cjs`; forks must change that constant.
Only package an x64 build under this asset name. No release is published by a
local build.

Checks: `npm run build`, `npm test`, `node scripts/updates-ui-smoke.mjs`,
`node scripts/ui-flow-smoke.mjs --built`, and an NSIS build. UI/update tests use
synthetic data and never execute a downloaded binary. A real upgrade between
two separately versioned releases, UAC and recovery after installer failure
still require an isolated Windows acceptance check.

References: [NSIS integration](https://www.electron.build/v26/docs/nsis/),
[GitHub release API and asset digests](https://docs.github.com/en/rest/releases/releases).
