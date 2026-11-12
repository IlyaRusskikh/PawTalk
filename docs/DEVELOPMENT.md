# Разработка PawTalk / Local development

Эта инструкция описывает разработку Client 0.10.1, Server 0.10.1 и Manager 0.2.1. Постоянный VPS использует Docker Compose и [SERVER.md](SERVER.md); приведённый ниже `docker run` предназначен для локального тестирования.

This guide covers Client 0.10.1, Server 0.10.1 and Manager 0.2.1 development. Production VPS deployment uses Docker Compose; see [SERVER.md](SERVER.md).

## Что нужно / Requirements

- Windows 10/11 x64 для клиента и нативного модуля; Node.js **24.22.1+** с npm, Go **1.27.3+**, Python **3.13** и Visual Studio Build Tools (Desktop development with C++ + Windows SDK) для локальной сборки клиента. См. [GUIDE.ru.md](GUIDE.ru.md).
- Docker Desktop с Linux-контейнерами либо Linux Docker Engine для локального контейнера сервера.
- Docker **Compose plugin не требуется**. Серверный образ содержит Go API и LiveKit. Для локальной разработки используются только порты `127.0.0.1:18443/tcp`, `18444/tcp`, `18445/udp`.

Docker Compose is not needed: the standalone server image bundles Go and LiveKit.

## Быстрый запуск / Quick start

На машине с Docker из корня репозитория:

```powershell
npm run dev:server
```

Команда запускает через `docker run` опубликованный образ той версии, которая указана в `package.json`, в режиме **только localhost**. В логе первого запуска появится автоматически созданный пароль. **Не публикуйте пароль или полный инвайт.**

В отдельном терминале на Windows:

```powershell
npm ci
npm run native:build
npm run dev
```

Приложение можно подключить к локальному серверу через полный `pawtalk://`-инвайт с отпечатком TLS-сертификата. Текущую ссылку можно получить командой:

```powershell
docker exec pawtalk-dev-server /pawtalk serve info
```

Введите пароль, выданный при первом запуске. Если сервер уже запускался и пароль потерян, см. команду `serve reset-password` в [SERVER.md](SERVER.md), предварительно убедившись, что обращаетесь к правильному тестовому контейнеру.

Остановите `dev:server` через Ctrl+C. Контейнер создаётся с `--rm`, но том `pawtalk-dev-server-data` сохраняется для TLS-идентичности, пароля и тестового чата. Не удаляйте том, если хотите сохранить данные. `npm run dev:server` использует имя контейнера `pawtalk-dev-server`, поэтому второй параллельный экземпляр не запускается.

### Проверка изменений в Go-сервере / Server source changes

Чтобы собрать локальный образ из текущего исходного кода Go и LiveKit:

```powershell
npm run dev:server -- --build
```

Эта команда сначала выполняет `docker build -f server/standalone.Dockerfile -t pawtalk-server:dev .`, затем запускает `docker run` с теми же безопасными ограничениями и локальными портами.

Для ускоренной проверки Go-кода без контейнера:

```powershell
cd server
go test ./...
go vet ./...
```

**Ограничение локального режима:** он не предназначен для приглашений через интернет и не заменяет production Compose. Чтобы проверить LAN-разговор, создайте комнату прямо в Windows-клиенте и передайте LAN-приглашение второму ПК ([первый разговор](FIRST-CALL.ru.md)). Отдельный Caddy/CA и Docker Compose для этого не нужны.

## Проверки / Tests

| Команда | Что проверяет |
| --- | --- |
| `npm run build` | TypeScript, production-сборка интерфейса |
| `npm test` | JS unit-тесты |
| `npm run server:prepare`, затем `node scripts/update-relay-smoke.mjs` (Windows, доступ к GitHub) | Реальные Go self-host + LiveKit и Electron: клиенту запрещён прямой GitHub, обнаружение релиза через LAN-закладку, полная загрузка опубликованного EXE и проверка подписи/размера/SHA-256, собственная комната через loopback, отказ при устаревшем TLS-отпечатке. EXE не запускается. Использует временную комнату на портах 31443–31446 и штатный автопроброс роутера; проверка на одном компьютере не подтверждает доступность извне |
| `npm run smoke` | Интерфейс и тестовый аудиотракт Electron |
| `npm run test:server` | Изолированный Docker-сервер, аутентификация и голосовой smoke |
| `npm run test:docker` | Изолированные Go API и LiveKit через `docker run`, Electron-интеграция |
| `npm run test:docker -- --containers-only` | Реальный запуск двух Docker-контейнеров, HTTP LiveKit, авторизация Go API, подпись и права JWT; без Electron |
| `npm run dev:server -- --smoke` | Временный запуск точно той же `docker run`-конфигурации dev-сервера из локального образа `pawtalk-server:local`; TLS fingerprint, HTTPS, ограничения контейнера, очистка ресурсов |
| `python3 tests/compose_integration.py` (Linux) | Настоящие Compose, локальный registry, install/reinstall, SQLite backup, Server rollout, неисправный образ, SIGKILL, Manager update без рестарта и fresh restore |
| `npm run check:public` | Эвристическая проверка случайной публикации секретов |
| `node scripts/check-website.mjs` | Сайт, локальные ссылки, метаданные |
| `python3 -m unittest discover -s tests -p '*_test.py'` (Linux) | Подписи, семейства релизов, конфигурация, backup/rollback, аварии, архивы и launcher fallback |
| `go test -race ./...` (в `server`) | Go-тесты с race detector |
| `go vet ./...` (в `server`) | Go static analysis |

`test:server` и `test:docker` запускают тестовые Docker-контейнеры; нужен Docker daemon и свободные порты, указанные в тестах. `test:docker` ориентирован на Linux Docker Engine. Режим `--containers-only` использует порты 8080/7880/7881/7882 и не требует Electron или `npm ci`; он не проверяет звук двух клиентов. `dev:server -- --smoke` использует порты 32443–32445 и образ `pawtalk-server:local`, который предварительно создаёт `node scripts/server-smoke.mjs` или команда `docker build -f server/standalone.Dockerfile -t pawtalk-server:local .`.

CI на Linux AMD64 и ARM64 проверяет Go/race/vet, Docker lifecycle, Compose install/update/backup/restore/SIGKILL и контракт с опубликованным сервером 0.8.0. Это локальные контейнерные сценарии; реальные микрофоны и внешние сети остаются в ACCEPTANCE.md.

## Сервер на VPS / VPS

Для VPS используйте проверенный установщик и Compose-шаблон `manager/compose.server.yaml`. Локальный `docker run` не заменяет production lifecycle:

```sh
sudo python3 manager/pawtalkctl install
```

Подробные инструкции с правилами firewall, backup и независимыми обновлениями: [SERVER.md](SERVER.md). Миграция старых установок не предусмотрена.

## Предосторожности / Safety

Секреты и данные сервера сохраняются отдельно от Git. Не публикуйте `.env`, приватные TLS-ключи, `state.json`, пароли, полные приглашения, записи разговоров или каталоги `release/qa`. Подписанный Windows-установщик пока не доступен; актуальные ограничения описаны в [README](../README.ru.md), [SECURITY](../SECURITY.md) и [CHANGELOG](../CHANGELOG.md).
