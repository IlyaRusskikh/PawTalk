# Архитектура системы

[English](overview.en.md) · [Индекс](README.ru.md)

PawTalk — монорепозиторий с **тремя независимо выпускаемыми компонентами**. **Client** — Windows-приложение Electron/React. **Server** — Go API и медиасреда LiveKit; временный Windows selfhost и постоянные Windows/Linux установки используют единое ядро `apps/server/`. **Manager** — хостовый установщик и контроллер: Windows UI/службы либо Linux CLI/Compose.

~~~text
Windows Client ─ TLS/API и медиа ─► PawTalk Server (Go API + LiveKit)
      │                                │
      ├─ ключи в OS vault             ├─ членство, роли, каналы
      ├─ локальное E2EE               ├─ шифрованные сообщения/вложения
      └─ временный Server host        └─ state + SQLite на постоянном Server
                                          ▲
                                       Manager
                             (служба Windows / Linux Compose)
~~~

API 2 объединяет модель идентичности, вступления и каналов. Членство даёт доступ к API; в голос нужно входить отдельно. Постоянный Server сохраняет SQLite schema 2; временный selfhost хранит состояние и чат в памяти. Сервер видит TLS-запросы и метаданные, но не открытое содержимое E2EE.

**Границы релизов:** Client `client-v*`, Server `server-v*`, Manager `manager-v*`. Windows и Linux Manager имеют общий тег; описания релизов охватывают применимые платформы. API 1 несовместим; миграции данных нет. [Совместимость](../docs/server/compatibility.ru.md).

[Компоненты](components.ru.md) · [Безопасность](security.ru.md).
