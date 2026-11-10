# 0.9.0 — карта изменений для ревью

Статус на **2026-11-11**: локальная ветка `0.9.0`, без push, release tags,
публикации GitHub/GHCR/сайта или действий на реальном VPS. Тестовые `docker push`
выполнялись только в одноразовый loopback registry, с временными ключами.

## Решения владельца

- Сначала Client-only bridge `v0.8.1`, затем `client-v0.9.0`; двойных тегов одной
  версии нет. Bridge сохранён отдельным локальным коммитом `3747a0d`.
- Windows temporary self-host сохранён. Удалено только постоянное размещение
  на Windows и его Linux VM-инструкция; новые VPS используют Compose.
- Client сохраняет свой ключ; Server и Deploy имеют отдельные trust roots.
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
| VPS runtime | `deploy/compose.server.yaml`, `pawtalk_agent/runtime.py` | UID 65532, host networking, exact image digest, ownership checks |
| Установка/config | `deploy/pawtalkctl`, `pawtalk_agent/cli.py`, `config.py`, `preflight.py` | Подписанный Deploy handoff, строгий data-only config, Docker bootstrap consent, идемпотентность |
| Backup/update | `pawtalk_agent/controller.py` | Lock/journal/fsync, остановочный backup, health/identity, откат данных вместе с образом |
| Deploy update | `pawtalk_agent/bundles.py`, `deploy/launcher` | Подпись/allowlist, self-test, atomic pointers/fallback, отсутствие лишнего Server restart |
| Recovery/doctor | controller/CLI и systemd units | Crash recovery, restore на чистом хосте, bounded watchdog, диагностика без секретов |

Swarm deployment/updater/smoke/config, их production-инструкции и постоянный Windows
guide удалены. Миграции и очистки чужих ресурсов нет. История в CHANGELOG/старых
Git-тегах сохранена. README на двух языках и сайт явно обозначают 0.9.0 как
неопубликованную разработку, сохраняя действующую ссылку на public Client 0.8.0.

## Проверки

| Проверка | Локальный результат и граница |
|---|---|
| `npm run build` | TypeScript/Vite прошли; обычное предупреждение о размере JS chunk |
| `npm test` с Go 1.27.3 | 135 passed, 0 failed, 0 skipped; настоящий PowerShell/Electron helper и TLS diagnostic command |
| Python host tools | 22 passed: signatures, routes, archive faults, config, rollback/journal, lock/watchdog, wizard RU/EN, безопасная диагностика и защита чужого project при restore |
| Go | `go test ./...`, `go vet ./...`, `go test -race ./...` прошли в Linux amd64 контейнере |
| Compose | Debian 12 и Ubuntu 24.04 userspace на Docker Desktop; реальные Docker/Compose/registry и временные signing keys |
| E2EE lifecycle | E2EE policy/key ID и opaque history проверены при install/update/rollback/restore; это не аппаратное испытание шифрованного голоса |
| Actual SIGKILL | Настоящее завершение controller процесса после начала rollout, recovery по durable journal |
| Deploy-only | Проверено сохранение container ID и Server digest при неизменном Compose runtime |
| Fresh restore | Проверка подписанных Server/Deploy receipts, восстановление кода/SQLite/TLS/пароля в новую директорию хоста и новый volume |
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

1. Владелец должен предоставить Server/Deploy **публичные** ключи в `deploy/trust.json`
   и настроить соответствующие CI secrets. Сейчас roots пусты намеренно: неподписанная
   production-установка/публикация блокируется, временные test keys не используются в продукте.
2. Проверить отдельный checkout bridge `3747a0d` перед будущим выпуском `v0.8.1`.
   Проверки финального 0.9.0 не заменяют pre-release прогон этого checkout.
3. Реальный native Linux/arm64 и реальные systemd oneshot units предусмотрены в CI,
   но GitHub Actions здесь не запускались: push не выполнялся. Локальные контейнеры
   не проверяют полноценную загрузку ОС и установку Docker через apt на чистом VPS.
4. Реальные микрофоны/два устройства/внешний TCP/UDP не проверены и не объявляются
   успешными. Native arm64 не подменяется эмуляцией.
5. Схемы API/data/config/launcher сейчас 1. Необратимые data migrations, смена IP/порта
   существующей комнаты, замена/удаление trust roots и обновление stable launcher
   требуют отдельного контролируемого пути; обычное обновление их блокирует.

Первый будущий порядок публикации после отдельного разрешения: bridge → Server →
Deploy → Client. Затем линии независимы. [Полная инструкция](RELEASING.md).
