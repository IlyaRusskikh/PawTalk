# 0.9.0 — карта изменений для ревью

Статус на **2026-11-11**: локальная ветка `0.9.0`, без push, release tags,
публикации GitHub/GHCR/сайта или действий на реальном VPS. Тестовые `docker push`
выполнялись только в одноразовый loopback registry, с временными ключами.

## Решения владельца

- Сначала Client-only bridge `v0.8.1`, затем `client-v0.9.0`; двойных тегов одной
  версии нет. Bridge сохранён отдельным локальным коммитом `3747a0d`.
- Windows temporary self-host сохранён. Постоянный Windows-сервер добавлен обратно
  как нативные службы с общим Manager controller; Linux использует Compose.
- Client сохраняет свой ключ; Server и Manager имеют отдельные trust roots.
- Реальные VPS/два физических Windows устройства недоступны. Приёмка использует
  локальный Docker, реальный Electron с synthetic audio и подготовленные GitHub Actions.

Исходный аудит: `main` был уже 0.8.0 (не 0.7.1 из первоначального ТЗ); общий
`package.json` управлял серверным GHCR тегом и Client release. Старый updater
не распознавал `client-v*`, relay также принимал только legacy-теги, серверный
updater читал неподписанный digest из release notes и только первую страницу.

## Где смотреть код

| Область | Основные файлы | Что проверить |
|---|---|---|
| Версии/теги/каналы | `shared/release.cjs`, `scripts/release-contract.mjs`, три version sources | Независимость версий, SemVer, запрет cross-publication, stable/preview |
| Bridge/Client update | `electron/updater.cjs`, `update-transport.cjs`, `update-manifest.cjs`, `update-settings.cjs` | Сохранение точного тега при загрузке, подпись, каналы и anti-rollback floors |
| Client UI | `src/UpdateSettings.tsx`, main/preload IPC | Сохранение канала, валидация IPC, RU/EN, общий 20px field gap |
| Windows self-host | `bundled-server.json`, `scripts/prepare-server.mjs`, package resource allowlist | Точный commit/Go/LiveKit, receipt с хэшами, отсутствие случайных старых EXE |
| API compatibility | `shared/protocol.cjs`, `server/profile.go`, `docs/COMPATIBILITY.md` | Legacy protocol 1, capabilities, блокировка неизвестного явного протокола до входа |
| CI/CD | `.github/workflows/check.yml`, `release.yml`, `scripts/release-metadata.mjs` | Tag/version gate, отдельные ключи/артефакты, проверки до публикации, immutable releases |
| VPS runtime | `manager/compose.server.yaml`, `pawtalk_manager/runtime.py` | UID 65532, host networking, exact image digest, ownership checks |
| Установка/config | `manager/pawtalkctl`, `pawtalk_manager/cli.py`, `config.py`, `preflight.py` | Подписанный Manager handoff, строгий data-only config, Docker bootstrap consent, идемпотентность |
| Backup/update | `pawtalk_manager/controller.py` | Lock/journal/fsync, остановочный backup, health/identity, откат данных вместе с образом |
| Manager update | `pawtalk_manager/bundles.py`, `manager/launcher` | Подпись/allowlist, self-test, atomic pointers/fallback, отсутствие лишнего Server restart |
| Recovery/doctor | controller/CLI и systemd units | Crash recovery, restore на чистом хосте, bounded watchdog, диагностика без секретов |

Swarm deployment/updater/smoke/config, их production-инструкции и постоянный Windows
guide удалены. Миграции и очистки чужих ресурсов нет. История в CHANGELOG/старых
Git-тегах сохранена. README на двух языках и сайт явно обозначают 0.9.0 как
неопубликованную разработку, сохраняя действующую ссылку на public Client 0.8.0.

## Проверки

| Проверка | Локальный результат и граница |
|---|---|
| `npm run build` | TypeScript/Vite прошли; обычное предупреждение о размере JS chunk |
| `npm test` с Go 1.27.3 | 139 passed, 0 failed, 0 skipped; настоящий PowerShell/Electron helper, CMD/PS генераторы и TLS diagnostic command |
| Python host tools | 29 passed: signatures, routes, archive faults, config, rollback/journal, lock/watchdog, wizard RU/EN (включая настоящую PTY-вставку), Windows version gate, безопасная диагностика и защита чужого project при restore |
| Windows native | Настоящие Go/LiveKit, SQLite, TLS/E2EE policy, закрытый pipe Ed25519, cross-process lock, backup/update/rollback, Manager-only update и kill-on-close job; console service protocol, без регистрации SCM |
| Windows SCM | Подготовлены jobs Windows Server 2022/2025; локально нет административного токена. Реальные SCM/LocalService ACL и весь целевой набор ОС ещё требуют успешного CI/проверки |
| Go | `go test ./...`, `go vet ./...`, `go test -race ./...` прошли в Linux amd64 контейнере |
| Compose | Debian 12 и Ubuntu 24.04 userspace на Docker Desktop; реальные Docker/Compose/registry и временные signing keys |
| E2EE lifecycle | E2EE policy/key ID и opaque history проверены при install/update/rollback/restore; это не аппаратное испытание шифрованного голоса |
| Actual SIGKILL | Настоящее завершение controller процесса после начала rollout, recovery по durable journal |
| Manager-only | Проверено сохранение container ID и Server digest при неизменном Compose runtime |
| Fresh restore | Проверка подписанных Server/Manager receipts, восстановление кода/SQLite/TLS/пароля в новую директорию хоста и новый volume |
| Native/UI | Нативный модуль, main/preload IPC, поля/кнопки, RU/EN, normal/reduced motion, clipboard representations, voice/chat/diagnostics smoke |
| Client ↔ old Server | Опубликованный Server 0.8.0 по immutable digest, TLS/auth и два настоящих Electron/LiveKit клиента с synthetic audio |
| Client ↔ new Server | Новый локальный Go/LiveKit image, двусторонний RTP, mute/PTT/rejoin и фактический playback gain |
| NSIS/packaged | Локальный installer построен; packaged smoke проверяет native, IPC, self-host, pinned receipt и хэши, allowlist бинарников |
| Workflows/site | actionlint и `check-website.mjs` прошли; публикация не запускалась |

Обнаруженные при проверках проблемы получили регрессии: TCP `TIME_WAIT` не считается
занятым listening-портом; холодная Windows Go-компиляция сертификата имеет отдельный
достаточный timeout; gain измеряется одновременно до/после playback node, а не на
разных участках нестационарного synthetic microphone.

## Что остаётся перед настоящим выпуском

1. Production-публичные ключи Server/Manager настроены в `manager/trust.json`,
   соответствующие GitHub secrets созданы. Временные test keys не используются в продукте.
   До публикации подписанных релизов обычная установка остаётся недоступна.
2. Отдельный неизменённый checkout bridge `3747a0d` локально прошёл build,
   128 тестов без пропусков, native smoke, public guard, NSIS packaging и packaged
   smoke. Первый параллельный прогон дал таймаут PowerShell-теста; отдельный тест
   и полный повторный набор прошли. Перед tag push нужны остальные применимые
   шаги его собственного workflow; проверки 0.9.0 их не заменяют.
3. Native Linux amd64/arm64, systemd oneshot units и Windows Server 2022/2025 SCM/EXE
   прошли branch CI на `ec45dae`; финальный кандидат с ключами и изменением UI проверяется
   отдельно. Локальные контейнеры
   не проверяют полноценную загрузку ОС и установку Docker через apt на чистом VPS.
4. Реальные микрофоны/два устройства/внешний TCP/UDP не проверены и не объявляются
   успешными. Native arm64 не подменяется эмуляцией.
5. Схемы API/data/config/launcher сейчас 1. Необратимые data migrations, смена IP/порта
   существующей комнаты, замена/удаление trust roots и обновление stable launcher
   требуют отдельного контролируемого пути; обычное обновление их блокирует.

Первый будущий порядок публикации после отдельного разрешения: bridge → Server →
Manager → Client. Затем линии независимы. [Полная инструкция](RELEASING.md).

## Финальный кандидат с production roots и кнопкой обновления

Код `9250e74` локально проверен на Windows: Client build, 139 тестов без пропусков,
update-layout/update-dialog/fixes-main/UI-flow (RU/EN, normal/reduced motion,
фактический Electron IPC), сборка NSIS и packaged smoke. Manager EXE пересобран
с публичными production roots; три Windows process/NTFS/SQLite regression-теста,
Go host tests/vet и native console/job lifecycle прошли. Последний включает
двусторонний encrypted RTP с настоящими Electron-клиентами и synthetic audio,
backup/update/rollback/restore; локальная регистрация SCM не выполнялась без admin.

На Debian 12 в Docker: 29 Python-тестов прошли, три Windows-only теста пропущены;
реальный Compose E2EE install/update/data rollback/SIGKILL recovery/Manager-only
update/backup/fresh-root restore прошёл. Actionlint и website/public guards прошли.
Подтверждено соответствие production private/public keys перед загрузкой двух
GitHub secrets; закрытые ключи не включены в Git или CI artifacts. Публикация не
выполнялась. После push требуется отдельный branch CI финального дерева; это
не результат будущего tag workflow и не проверка внешнего VPS/физических устройств.
