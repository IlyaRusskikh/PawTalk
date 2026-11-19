# Карта компонентов и исходников

[English](components.en.md) · [Индекс](README.ru.md)

| Ответственность | Основная реализация |
| --- | --- |
| Интерфейс, звук и настройки Client | [`apps/client/windows/src/`](../apps/client/windows/src), [`apps/client/windows/electron/`](../apps/client/windows/electron) |
| Сессии Client↔Server, приглашения, E2EE | [`apps/client/windows/electron/membership-client.cjs`](../apps/client/windows/electron/membership-client.cjs), [`apps/client/windows/src/membership.ts`](../apps/client/windows/src/membership.ts) |
| Go API, авторизация, приглашения, модерация, voice grants | [`apps/server/membership_*.go`](../apps/server), [`apps/server/main.go`](../apps/server/main.go) |
| Контракт постоянного хранилища | [`apps/server/membership.sql`](../apps/server/membership.sql) |
| Windows Manager UI и контроллер службы | [`apps/manager/windows/desktop/`](../apps/manager/windows/desktop), [`apps/manager/windows/service/`](../apps/manager/windows/service) |
| Linux Manager CLI, транзакции и проверка | [`apps/manager/linux/pawtalk_manager/`](../apps/manager/linux/pawtalk_manager), [`apps/manager/linux/pawtalkctl`](../apps/manager/linux/pawtalkctl) |
| Управляемое Linux-развёртывание | [`apps/manager/linux/deploy/compose.server.yaml`](../apps/manager/linux/deploy/compose.server.yaml), units systemd |
| Сборки, release manifest и CI | [`tooling/`](../tooling), [`.github/workflows/`](../.github/workflows) |
| Интеграционные, security и release-тесты | [`tests/`](../tests), [Go tests](../apps/server) |

Windows Client поставляет общее ядро Go/LiveKit для временных комнат, Server release — то же ядро для постоянных серверов. Сборочные входы должны совпадать; исторические бинарники неизменяемы.

Полномочия хостового Manager отличаются от **роли администратора внутри PawTalk Server**. Пользователь root/sudo или оператор службы Windows не становится автоматически участником E2EE и не получает клиентские ключи.
