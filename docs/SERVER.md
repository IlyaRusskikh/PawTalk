# PawTalk Server — установка и управление / Installation and operation

## Актуальные руководства / Current guides

- **[Debian VPS: Server API 2 с нуля](SERVER-DEBIAN.md)** — основная Linux-инструкция:
  доверенный bootstrap, Docker/Compose, первое вступление администратора,
  проверка перезагрузки, обновления, backup/restore и удаление с сохранением данных.
- [API 2: каналы, членство и управление](SERVER-API2.md) — общая модель Client/Server,
  Windows и встроенный временный хост.
- [Windows Server](SERVER-API2.md#windows-first-server-setup) — первоначальная
  установка через Manager UI, отдельный от Linux способ размещения.
- [Совместимость](COMPATIBILITY.md) и
  [актуальные опубликованные версии](https://ilyarusskikh.github.io/PawTalk/downloads/).

API 2 опубликован. Нужны чистые конфигурация и данные API 2; автоматической
миграции установок/backup API 1 нет. Server, Manager и Client обновляются независимо.

**English:** Start with the **[Debian VPS API 2 guide](SERVER-DEBIAN.md)** for a fresh
permanent Linux server. It covers trusted installation, Docker/Compose, first-admin
admission, reboot acceptance, updates, backup/restore and data-preserving uninstall.
Use the API 2 guide for Windows/UI and shared membership behavior. API 2 is published;
API 1 migration is unsupported. Select versions from GitHub Releases, not source manifests.

## История API 1 / API 1 history

[Старое руководство](archive/SERVER-API1.md) сохранено как исторический снимок:
пароль комнаты, необязательное E2EE и ручной key ID относятся к старому контракту.
Не применяйте его команды и предположения к новой установке API 2.

[The archived API 1 guide](archive/SERVER-API1.md) is historical only; password-based
admission, optional E2EE and manual key IDs do not describe API 2 installation.
