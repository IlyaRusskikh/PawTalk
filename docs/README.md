# PawTalk — актуальная документация / Current documentation

Актуальные опубликованные версии / Current published versions:
[Client, Server, Manager](https://ilyarusskikh.github.io/PawTalk/downloads/).
История / History: [CHANGELOG](../CHANGELOG.md), [release notes](releases/).
Для AI-агентов / For AI agents: [AGENTS.md](../AGENTS.md), [knowledge index](../agents/README.md).

## Пользователям / For users

| Раздел | Описание |
| --- | --- |
| [README на русском](../README.ru.md) · [English README](../README.md) | Возможности, ограничения и установка Windows-клиента / Overview and downloads |
| [Первый разговор](FIRST-CALL.ru.md) | Установка, приглашение и проверка микрофона на двух ПК |
| [Руководство](GUIDE.ru.md) | Настройки, локальная сеть, ошибки подключения и тесты |
| [Настройки](SETTINGS.md) | Актуальное расположение всех настроек / Current settings reference |
| [E2EE](E2EE.md) | Шифрование, ключи и ограничения модели безопасности / Experimental encryption |
| [Политика безопасности](../SECURITY.md) | Как сообщить об уязвимости / Report vulnerabilities |

## Владельцам сервера / For server operators

| Раздел | Описание |
| --- | --- |
| [Установка VPS](SERVER.md) | Docker Compose, мастер, отдельные подписанные обновления, backup/restore |
| [Manager desktop](MANAGER-DESKTOP.md) | Новый Windows UI, трей, обновления и границы проверки / New Windows UI and verification |
| [Совместимость](COMPATIBILITY.md) | API protocol, Client ↔ Server, переход 0.8.1 и Windows self-host |
| [Обновления клиента и язык](UPDATES.md) | Подписанные обновления клиента и резервная передача через комнаты |

Новый VPS использует [`manager/compose.server.yaml`](../manager/compose.server.yaml) через проверенный host controller. Постоянный Windows-сервер использует нативные службы и общий Manager: [WINDOWS-SERVER.md](WINDOWS-SERVER.md). Встроенные временные Windows-комнаты сохранены.

New VPS installations use Docker Compose through the verified host controller. Permanent Windows hosting uses native services and the shared Manager; see [WINDOWS-SERVER.md](WINDOWS-SERVER.md). Temporary Windows rooms remain.

## Разработчикам / For developers

| Раздел | Описание |
| --- | --- |
| [Разработка и локальный запуск](DEVELOPMENT.md) | `docker run`, сборка клиента, тесты; без Compose / Local development |
| [Архитектура](ARCHITECTURE.md) | Компоненты клиента, сервера, голосового тракта и обновлений |
| [API](API.md) | Протокол подключения и чата |
| [Проверки](VERIFICATION.md) | Технический журнал выполненных проверок; историческая QA-запись, не инструкция |
| [План аппаратной приёмки](ACCEPTANCE.md) | Что ещё не подтверждено на реальном оборудовании |
| [Публикация релиза](RELEASING.md) | Версия, CI, GitHub Releases и GHCR |
| [Подпись обновлений](UPDATE-SIGNING.md) | Ed25519-манифест и ключи |

План сопровождения и унификации встроенного ядра / Bundled-core maintenance and unification: [BUNDLED-SERVER.md](BUNDLED-SERVER.md).

Исторические снимки / Historical records: [карта 0.9.0](IMPLEMENTATION-0.9.0.md), [выполненный bridge-переход](archive/CLIENT-BRIDGE-0.8.1.md).

Документы с историей старого процесса первой публикации не являются актуальными руководствами: изменения и номера выпусков сохранены в Git и [CHANGELOG](../CHANGELOG.md).
