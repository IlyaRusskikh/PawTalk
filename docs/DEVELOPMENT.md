# Разработка PawTalk / Local development

Эта инструкция описывает текущий PawTalk 0.7.1. Для постоянного сервера на VPS используйте **только Docker Swarm** и [SERVER.md](SERVER.md), а не приведённый ниже локальный `docker run`.

This guide covers local development of PawTalk 0.7.1. Production VPS deployment uses **Docker Swarm only**; see [SERVER.md](SERVER.md).

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

**Ограничение локального режима:** он не предназначен для приглашений через интернет и не заменяет Swarm. Чтобы проверить LAN-разговор, создайте комнату прямо в Windows-клиенте и передайте LAN-приглашение второму ПК ([первый разговор](FIRST-CALL.ru.md)). Отдельный Caddy/CA и Docker Compose для этого не нужны.

## Проверки / Tests

| Команда | Что проверяет |
| --- | --- |
| `npm run build` | TypeScript, production-сборка интерфейса |
| `npm test` | JS unit-тесты |
| `npm run smoke` | Интерфейс и тестовый аудиотракт Electron |
| `npm run test:server` | Изолированный Docker-сервер, аутентификация и голосовой smoke |
| `npm run test:docker` | Изолированные Go API и LiveKit через `docker run`, Electron-интеграция |
| `npm run check:public` | Эвристическая проверка случайной публикации секретов |
| `node scripts/check-website.mjs` | Сайт, локальные ссылки, метаданные |
| `python -m unittest discover -s tests -p server_update_test.py` | Тесты утилиты обновления Swarm |
| `go test -race ./...` (в `server`) | Go-тесты с race detector |
| `go vet ./...` (в `server`) | Go static analysis |

`test:server` и `test:docker` запускают тестовые Docker-контейнеры; нужен Docker daemon и свободные порты, указанные в тестах. `test:docker` ориентирован на Linux Docker Engine; проверить аудио, реальные микрофоны, сеть между физическими ПК и античит отдельно по [ACCEPTANCE.md](ACCEPTANCE.md). Синтетические тесты этого не доказывают.

## Сервер на VPS / VPS

Для VPS не используйте команды `npm run dev:server` или `docker run`. Используется **`compose.server.swarm.yaml` исключительно как Swarm stack specification**, внешний Docker volume и `scripts/server-update.py` с действиями `deploy`, `check`, `update`, `rollback`:

```sh
python3 scripts/server-update.py deploy --config .env --stack pawtalk
```

Подробные инструкции с правилами firewall, бэкапом, миграцией и обновлениями: [SERVER.md](SERVER.md) и [SWARM.md](SWARM.md).

## Предосторожности / Safety

Секреты и данные сервера сохраняются отдельно от Git. Не публикуйте `.env`, приватные TLS-ключи, `state.json`, пароли, полные приглашения, записи разговоров или каталоги `release/qa`. Подписанный Windows-установщик пока не доступен; актуальные ограничения описаны в [README](../README.ru.md), [SECURITY](../SECURITY.md) и [CHANGELOG](../CHANGELOG.md).
