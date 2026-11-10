# PawTalk — актуальная документация / Current documentation

Документация ниже описывает **текущий предварительный выпуск 0.8.0**. Историю изменений между версиями смотрите в [CHANGELOG](../CHANGELOG.md), а не в руководствах по установке.

The guides below describe the **current 0.8.0 public preview**. For older releases, consult the [changelog](../CHANGELOG.md), not the installation guides.

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
| [Постоянный сервер на Windows](SERVER-WINDOWS.md) | Docker Swarm в Linux VM: сеть, автозапуск и проверка / Always-on Windows PC with a Linux VM |
| [Установка VPS](SERVER.md) | **Только Docker Swarm**: с нуля до рабочей комнаты, сеть, volume, резервное копирование |
| [Swarm: обслуживание](SWARM.md) | Миграция, обновления, откат, systemd-таймер |
| [Обновления клиента и язык](UPDATES.md) | Подписанные обновления клиента и резервная передача через комнаты |

Для нового VPS **не используется Docker Compose**. Единственная спецификация для постоянного VPS — [`compose.server.swarm.yaml`](../compose.server.swarm.yaml). Её читает `docker stack deploy`, а не `docker compose up`.

New VPS installations use Docker Swarm only. The stack specification named `compose.server.swarm.yaml` is consumed by `docker stack deploy`; the Docker Compose plugin is not required.

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
