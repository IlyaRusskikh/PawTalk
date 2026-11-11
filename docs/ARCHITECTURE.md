# Архитектура / Architecture — 0.10.0 (unreleased)

Один монорепозиторий, три независимых выпуска:

| Линия | Версия | Обновлятор | Доверие |
|---|---|---|---|
| Client | package manifests | Electron, `client-v*` + ограниченный legacy bridge | Существующий Client Ed25519 key, signed manifest + EXE hash |
| Server | `server/VERSION` | Host controller, только `server-v*` | Отдельный Server key + GHCR digest |
| Manager | `manager/VERSION` | Stable launcher/controller, только `manager-v*` | Отдельный Manager key + signed bundle hash |

Общий GitHub `/releases/latest` не используется. Client-only не публикует Server,
Server-only публикует серверный Windows ZIP, но не клиентский EXE, Manager-only не меняет Server digest и не перезапускает
голос, если эффективная runtime-конфигурация не меняется.

## Комната

Windows: Electron/React UI, LiveKit client, локальные обработчики микрофона,
native PTT/audio. Встроенная временная комната запускает Go API/LiveKit из pin
`bundled-server.json`; текущий pin совместим по API protocol 1. Постоянный Windows-сервер
использует актуальное ядро Go/LiveKit, службы Windows и общий Manager controller.

VPS: один Debian 12 / Ubuntu 24.04 amd64/arm64 host, Docker Engine + Compose v2+,
одна реплика Go API + LiveKit в одном контейнере, host networking. UID/GID 65532,
read-only rootfs, cap_drop ALL, no-new-privileges, tmpfs и постоянный volume `/data`.
Нет центральной панели, привилегированного приложения или Docker socket в сервере.
Production Compose: `manager/compose.server.yaml`. Swarm и его миграция не поддерживаются.

## Управление и состояние

`manager/pawtalk_manager/` — общий host-only Python controller. Linux использует
OpenSSL/Compose/systemd, Windows — встроенный Python, Go Ed25519 verifier,
SCM и файловые каталоги. [Windows setup и границы проверки](WINDOWS-SERVER.md).
systemd update/health timers вызывают стабильный launcher. Нет постоянно
работающего updater-контейнера; неисправность агента не останавливает здоровый голос.

- User config `/etc/pawtalk/config.env` отделён от `installed.json`: config не
  содержит digest/version и никогда не выполняется как shell.
- Managed state/journal хранит фактически установленный образ, Server/Manager
  версии, project/volume и хэш идентичности. Atomic write + fsync, общий flock.
- Volume сохраняет сертификат/ключ, пароль-хеш и SQLite. Новый manager создаёт
  новую комнату. Reinstall/update не пересоздаёт её идентичность.
- Backup останавливает комнату и архивирует все данные, config, template и
  image reference; завершённая копия публикуется только после checksum.
- Rollout failure или crash после применения восстанавливает согласованную
  пару «данные+образ» в новый том, сохраняя исходный том. Image-only rollback не применяется.
- Manager bundle распаковывается по строгому allowlist без ссылок/обхода путей,
  проверяется self-test, затем атомарно меняется `current`. Launcher проверяет
  controller и возвращает `previous` при отказе, отменяя текущую операцию.

Restart policy восстанавливает завершившийся процесс; unhealthy требует отдельного
watchdog с ограничением попыток/backoff. Контроллеры используют общий lock,
поэтому watchdog не конкурирует с backup/update. Выключенные auto-update линии
не делают плановых исходящих запросов. Явные `install`/`doctor`/update-команды
могут выполнять соответствующие загрузки и диагностику.

## Протокол и безопасность

API protocol 1 и capabilities объявляются через `/api/config`. Отсутствие поля
означает legacy protocol 1. [Совместимость](COMPATIBILITY.md), [API](API.md).
Release numbers не сравниваются для определения API-совместимости.

Приглашение закрепляет TLS fingerprint; пароль передаётся после pin check.
E2EE остаётся opt-in экспериментальным режимом; VPS хранит только SHA-256 key ID,
не секретный client key. [Ограничения E2EE](E2EE.md). Updater signatures не заменяют
Authenticode-подпись Windows installer. Trust roots и ротация: [RELEASING](RELEASING.md).

Серверный update допускает краткий обрыв звонка. Неподдерживаемые схемы данных
блокируются; zero downtime, кластеры, импорт старых VPS и IPv6 не входят в контракт.
Локальные/контейнерные проверки не подтверждают внешний UDP и реальные устройства.
[Приёмка](ACCEPTANCE.md), [проверки разработки](VERIFICATION.md).

## English

PawTalk keeps one monorepo with independent Client, Server and Manager releases.
Windows temporary rooms remain pinned and bundled. Permanent Windows hosting uses
native Go/LiveKit binaries and Windows services with the shared Manager controller. Linux uses one non-root Go/LiveKit container under Compose, a persistent
volume, host-only signed update tools and systemd timers. User config, managed
state and room data are separate. Transactional updates use stopped consistent
backups and restore the image/data pair after failure. Manager has versioned code,
atomic switching and a stable fallback launcher; unchanged runtime means no Server
restart. API protocol 1 is independent of release numbers. No real VPS or external
network/device acceptance is claimed by local Docker tests.
