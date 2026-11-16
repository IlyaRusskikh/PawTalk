# Карта компонентов и исходников

[English](components.en.md) · [Индекс](README.ru.md)

| Ответственность | Основная реализация |
| --- | --- |
| Интерфейс, звук и настройки Client | [`src/`](../src/), [`electron/`](../electron/) |
| Сессии Client↔Server, приглашения, E2EE | [`electron/membership-client.cjs`](../electron/membership-client.cjs), [`src/membership.ts`](../src/membership.ts) |
| Go API, авторизация, приглашения, модерация, voice grants | [`server/membership_*.go`](../server/), [`server/main.go`](../server/main.go) |
| Контракт постоянного хранилища | [`server/membership.sql`](../server/membership.sql) |
| Windows Manager UI и контроллер службы | [`manager/desktop/`](../manager/desktop/), [`manager/windows/`](../manager/windows/) |
| Linux Manager CLI, транзакции и проверка | [`manager/pawtalk_manager/`](../manager/pawtalk_manager/), [`manager/pawtalkctl`](../manager/pawtalkctl) |
| Управляемое Linux-развёртывание | [`manager/compose.server.yaml`](../manager/compose.server.yaml), units systemd |
| Сборки, release manifest и CI | [`scripts/`](../scripts/), [`.github/workflows/`](../.github/workflows/) |
| Интеграционные, security и release-тесты | [`tests/`](../tests/), [Go tests](../server/) |

Windows Client поставляет общее ядро Go/LiveKit для временных комнат, Server release — то же ядро для постоянных серверов. Сборочные входы должны совпадать; исторические бинарники неизменяемы.

Полномочия хостового Manager отличаются от **роли администратора внутри PawTalk Server**. Пользователь root/sudo или оператор службы Windows не становится автоматически участником E2EE и не получает клиентские ключи.
