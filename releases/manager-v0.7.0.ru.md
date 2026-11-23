# PawTalk Manager 0.7.0 — Managed migration to API 3

[English](manager-v0.7.0.en.md) · [Двуязычный источник](manager-v0.7.0.md)

Предварительный выпуск. Изменения относительно Manager 0.6.0.

[Windows GUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.0/PawTalk.Server.Manager.Setup.0.7.0.exe) · [Windows TUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.0/PawTalk.Server.Manager.TUI.Setup.0.7.0.exe) · [Linux](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.0/PawTalk.Manager.0.7.0.tar.gz)

### Добавлено

- Подготовка миграции постоянного Server с API 2 на API 3 включает проверку исходной комнаты, резервную копию и переключение после подтверждения владельца.
- Manager проверяет состояние миграции при обслуживании сервера и поддерживает восстановление из подготовленной копии.

### Установка и обновление

Обновите Manager своей редакции и Server до 0.14.0. Для подтверждения миграции используйте Client 0.15.0 владельца. Server обновляется отдельно.

## Ограничения

Для управления службой нужны права администратора или root. Переключение прерывает звонки. EXE без Authenticode.

## Файлы и исходники / Assets and source

PawTalk.Server.Manager.Setup.0.7.0.exe · PawTalk.Server.Manager.TUI.Setup.0.7.0.exe · PawTalk.Manager.0.7.0.tar.gz · manager-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.7.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.7.0/LICENSE)
