# PawTalk Manager 0.7.0 — Managed migration to API 3

Preview. Changes since Manager 0.6.0.
Предварительный выпуск. Изменения относительно Manager 0.6.0.

[Windows GUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.0/PawTalk.Server.Manager.Setup.0.7.0.exe) · [Windows TUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.0/PawTalk.Server.Manager.TUI.Setup.0.7.0.exe) · [Linux](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.0/PawTalk.Manager.0.7.0.tar.gz)

## Русский

### Добавлено

- Подготовка миграции постоянного Server с API 2 на API 3 включает проверку исходной комнаты, резервную копию и переключение после подтверждения владельца.
- Manager проверяет состояние миграции при обслуживании сервера и поддерживает восстановление из подготовленной копии.

### Установка и обновление

Обновите Manager своей редакции и Server до 0.14.0. Для подтверждения миграции используйте Client 0.15.0 владельца. Server обновляется отдельно.

## English

### Added

- Preparing a permanent Server migration from API 2 to API 3 includes inspecting the source room, creating a backup and switching after owner confirmation.
- Manager checks migration state during server maintenance and supports restoration from a prepared backup.

### Install or update

Update the installed Manager edition and update Server to 0.14.0. Use the owner’s Client 0.15.0 to confirm migration. Server updates independently.

## Ограничения / Limitations

Для управления службой нужны права администратора или root. Переключение прерывает звонки. EXE без Authenticode.

Service management requires administrator or root privileges. Cutover interrupts calls. The EXEs have no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Server.Manager.Setup.0.7.0.exe · PawTalk.Server.Manager.TUI.Setup.0.7.0.exe · PawTalk.Manager.0.7.0.tar.gz · manager-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.7.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.7.0/LICENSE)
