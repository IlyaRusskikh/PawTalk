# PawTalk — актуальная документация / Current documentation

Клиентские руководства относятся к публичной 0.8.0; Server/Architecture/Releasing описывают **разработку 0.9.0, ещё не выпущенную**. История — в [CHANGELOG](../CHANGELOG.md).

Client guides cover public 0.8.0; Server/Architecture/Releasing describe **unreleased 0.9.0 development**. See the [changelog](../CHANGELOG.md) for history.

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
| [Совместимость](COMPATIBILITY.md) | API protocol, Client ↔ Server, переход 0.8.1 и Windows self-host |
| [Обновления клиента и язык](UPDATES.md) | Подписанные обновления клиента и резервная передача через комнаты |

Новый VPS использует [`deploy/compose.server.yaml`](../deploy/compose.server.yaml) через проверенный host controller. Постоянное размещение на Windows больше не поддерживается; встроенные временные Windows-комнаты сохранены.

New VPS installations use Docker Compose through the verified host controller. Permanent Windows hosting is removed; temporary Windows rooms remain.

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
Документы с историей старого процесса первой публикации не являются актуальными руководствами: изменения и номера выпусков сохранены в Git и [CHANGELOG](../CHANGELOG.md).
