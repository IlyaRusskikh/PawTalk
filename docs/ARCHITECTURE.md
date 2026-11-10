# Архитектура PawTalk / Architecture

Это описание **текущей реализации 0.8.0**, а не проект старых выпусков. Детальный API находится в [API.md](API.md); изменения между версиями — в [CHANGELOG.md](../CHANGELOG.md).

## Компоненты

| Компонент | Где в исходниках | Назначение |
| --- | --- | --- |
| Windows desktop | `electron/main.cjs`, `electron/preload.cjs` | Electron main process, изолированный renderer, разрешённые IPC-операции, сохранение ключей и системные функции |
| UI | `src/`, `shared/` | React + TypeScript, экраны комнаты, голосовые настройки, профили, уведомления и чат |
| Голос | `livekit-client`, `src/` | WebRTC через LiveKit; микрофон, Push-to-Talk, выбор устройств, обработка звука |
| Нативные функции Windows | `native/` | Глобальные клавиши и интеграция с системным аудио |
| Серверное API | `server/` | Go: проверка доступа по паролю, выдача токенов, API чата и профилей, диагностика |
| Медиа-сервер | LiveKit | WebRTC-сигнализация и пересылка голоса |
| История | `server/chat*.go` | SQLite с ограничением объёма на постоянном сервере; встроенная комната может хранить историю в памяти |
| Обновления клиента | `electron/updater.cjs`, `electron/update-manifest.cjs` | Поиск GitHub Release, Ed25519-подпись манифеста, проверка SHA-256 установщика |
| Обновления VPS | `scripts/server-update.py`, `compose.server.swarm.yaml` | Docker Swarm: новый сервис, обновление по digest, проверка, откат |

## Два способа размещения комнаты

**Встроенная комната Windows:** клиент создаёт временную комнату и запускает локальные серверные компоненты. Комната работает, пока приложение/хост её поддерживает; после пересоздания нужен новый инвайт. Для первого LAN-разговора не требуется Docker ([первый звонок](FIRST-CALL.ru.md)).

**Постоянная комната Linux VPS:** готовый Docker-образ содержит Go API и LiveKit в одном контейнере. Docker Swarm управляет одной репликой с постоянным volume и закреплённым узлом. Релиз публикуется для linux/amd64 и linux/arm64. [SERVER.md](SERVER.md) · [SWARM.md](SWARM.md).

Файл `compose.server.swarm.yaml` — **спецификация стека Swarm**, используемая `docker stack deploy`. Для VPS не нужен Docker Compose plugin, нет поддерживаемой альтернативной установки через `docker compose up`.

**Локальная разработка:** этот же серверный образ можно запустить через `docker run` на localhost; это отдельный dev-сценарий, не способ развёртывания VPS. [DEVELOPMENT.md](DEVELOPMENT.md).

## Соединение и безопасность

- Клиент получает приглашение `pawtalk://` с отпечатком сертификата и проверяет TLS fingerprint до передачи пароля. Старое приглашение после пересоздания встроенной комнаты может перестать работать.
- Серверное API проверяет пароль PBKDF2, ограничивает попытки подключения и выдаёт краткоживущие токены LiveKit.
- E2EE **не включается автоматически**. В экспериментальном режиме используется общий случайный 256-битный ключ; для голосовых кадров и данных чата применяются механизмы шифрования клиента. Сервер видит сетевые метаданные; при выключенном E2EE он может читать историю чата. Нет автоматической смены ключа при уходе участника или forward secrecy. [E2EE.md](E2EE.md).
- Electron использует изолированный контекст renderer и проверку IPC; защищённые учётные данные сохраняются с помощью ОС.
- Установщик Windows пока не подписан Authenticode. Обновлятор проверяет манифест Ed25519 и SHA-256, но это не заменяет цифровую подпись издателя. [UPDATES.md](UPDATES.md).

## Хранение и эксплуатация

- Docker Swarm сервер использует внешний volume `/data`; он содержит секреты, TLS-идентичность и SQLite. Не удаляйте его при обновлении; создавайте резервные копии до изменений.
- Сетевые TCP/UDP-порты, host networking, ограничения контейнера и контроль работоспособности описаны в [SERVER.md](SERVER.md).
- Перед обновлением соблюдайте совместимость версий клиента и сервера. Релизные артефакты не перезаписываются.
- Автоматическая проверка обновлений клиента и отдельное opt-in обновление Swarm описаны в [UPDATES.md](UPDATES.md) и [SWARM.md](SWARM.md).

## Статус проверки

Unit, container и synthetic audio tests не заменяют проверку настоящих микрофонов, долгих разговоров, PTT в играх, потерь пакетов и разных сетей. Неотмеченные проверки перечислены в [ACCEPTANCE.md](ACCEPTANCE.md). Технический журнал тестов — [VERIFICATION.md](VERIFICATION.md).

---

**English summary:** PawTalk uses an Electron/React/TypeScript Windows client, a Go API, LiveKit for WebRTC, and SQLite for retained chat. A temporary room can run inside the Windows client. A persistent Linux room runs as one stateful Docker Swarm service using the bundled Go/LiveKit image; local development may use `docker run`. E2EE is optional and experimental, and the Windows installer is not yet Authenticode-signed. See the linked guides for exact setup, security limitations, and acceptance tests.
