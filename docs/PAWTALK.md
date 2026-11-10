# Переход с Voicecord на PawTalk / Voicecord migration

Этот документ описывает **текущую несовместимость** PawTalk 0.7.1 со старыми
установками Voicecord, а не историю разработки и переименования. История
выпусков и переходов — в [CHANGELOG](../CHANGELOG.md).

## Русский

PawTalk устанавливается **отдельно от Voicecord**. Автоматической миграции
настроек, профилей, серверных данных и старых приглашений нет.

- Завершите работу Voicecord. При необходимости удалите старый клиент и
  отключите его автозапуск, сохранив нужные пользовательские данные заранее.
- Установите актуальный PawTalk для Windows из
  [релиза 0.7.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/v0.7.1).
- Создайте новый профиль и комнату либо используйте новый `pawtalk://`-инвайт
  от владельца сервера. Ссылки Voicecord не совместимы с PawTalk.
- Для постоянной Linux-комнаты создайте новый volume и новые настройки
  `PAWTALK_*` по [инструкции Swarm](SERVER.md). **Не удаляйте прежний volume**
  до создания проверенной резервной копии. Не используйте прежние ключи и
  конфигурацию без отдельного подтверждённого плана миграции.
- Все участники одного сервера должны использовать совместимые версии.
  Возможности чата, например изменение сообщений, требуют актуального сервера.

Публичные релизы Voicecord, их бинарники и исходные теги остаются историей
проекта: старые релизы не перезаписываются. Для новых выпусков используйте
[RELEASING.md](RELEASING.md).

## English

PawTalk 0.7.1 installs **separately from Voicecord**. There is no automatic
migration for app profiles, settings, server state, or old invitations.

- Quit Voicecord and back up any data you need before uninstalling it or
  disabling its startup entry.
- Install PawTalk from the [0.7.1 release](https://github.com/IlyaRusskikh/PawTalk/releases/tag/v0.7.1).
- Create a fresh PawTalk profile and use a new `pawtalk://` invitation. Old
  Voicecord invitations cannot join PawTalk rooms.
- For a persistent Linux server, use a **new data volume and PAWTALK_***
  configuration with [Docker Swarm](SERVER.md). Back up the former volume
  before changing or removing anything.
- Keep clients and servers on compatible versions; newer chat features need
  an updated server.

Historical Voicecord releases and tags are retained unchanged. See the
[changelog](../CHANGELOG.md) for past versions and
[RELEASING.md](RELEASING.md) for the current publication process.
