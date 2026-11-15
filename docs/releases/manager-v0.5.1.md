# PawTalk Manager 0.5.1 — UI-first setup and API 2 admission

Preview for Windows x64 and Linux; changes since Manager 0.4.0. Prepared notes; publication/tag verification are pending.
Предварительная версия Windows x64 и Linux; изменения относительно Manager 0.4.0. Описание подготовлено; публикация и tag CI ещё не выполнены.

[Windows installer / Установщик](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.5.1/PawTalk.Server.Manager.Setup.0.5.1.exe) · [Linux/shared bundle](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.5.1/PawTalk.Manager.0.5.1.tar.gz).

Тег manager-v0.5.0 не прошёл проверку до публикации и сохранён без изменений; этот выпуск включает полное обновление относительно последней опубликованной версии.
The manager-v0.5.0 tag failed verification before publication and remains unchanged; this release includes the complete update since the last published version.

## Русский

### Добавлено

- На Windows первоначальная установка и последующая настройка Server выполняются через Electron UI: можно выбрать локальный пакет или явно загрузить опубликованный Server, настроить адрес/порты и запустить сервер. Переустановка Manager сама не скачивает и не устанавливает Server.
- Одноразовая ссылка первого администратора API 2 через интерфейс или CLI. Настроенный сервер выдаёт обычные приглашения через Client по правам администратора/модератора.

### Исправлено

- Windows-проверки отдельного Manager-выпуска заранее подготавливают LiveKit и интерфейс клиента для интеграционного Server-стенда.

- Установщик выбирает только язык Manager и не выполняет прежнюю настройку комнаты, которая могла завершаться ошибкой. Удалено устаревшее Win32-окно настроек, в том числе из тестовых путей.
- Локальные пакеты, резервное копирование, восстановление, обновление и диагностика учитывают API/data schema 2 и сохраняют проверки подписей, размеров и совместимости.

### Изменено

- Старые поля пароля и ручной генерации E2EE заменены моделью членства и обязательного клиентского шифрования. Windows/Linux управление использует то же Server ядро, что клиентский селфхост.

### Установка и обновление

Установите Manager 0.5.1 вручную из проверенного EXE/bundle; прежняя линия может отвергнуть API 2 metadata. Затем выберите Server 0.11.1 для нового API 2 каталога и используйте Client 0.12.1. Существующий Server не обновляется от одной переустановки Manager. Сохраните старую установку и backup отдельно: миграции API 1 истории/членства нет, её backup нельзя восстановить как API 2. Замена/остановка Server прерывает звонки. Для Linux скачайте проверенный bundle и используйте `manager/pawtalkctl` согласно руководству; UAC/SYSTEM или root нужны только для соответствующих операций хоста.

## English

### Added

- On Windows, initial and subsequent Server setup live in the Electron UI: choose a local package or explicitly download a published Server, configure address/ports and start it. Reinstalling Manager does not automatically download or install Server.
- One-use first-administrator API 2 invitation through UI/CLI. Configured servers issue regular invitations through authorized administrator/moderator Clients.

### Fixed

- Standalone Manager release checks prepare LiveKit and the Client renderer before building the integration Server fixture.

- Setup selects only Manager language and no longer runs the old room-configuration step that could fail installation. Removed the legacy Win32 settings form, including test paths.
- Local packages, backup/restore, updates and diagnostics account for API/data schema 2 while preserving signature, size and compatibility checks.

### Changed

- Password/manual E2EE generation fields give way to membership and mandatory client-side encryption. Windows/Linux hosting uses the same Server core as Client selfhost.

### Install or update

Manually install Manager 0.5.1 from a verified EXE/bundle; older Manager lines may reject API 2 metadata. Choose Server 0.11.1 with a fresh API 2 directory and use Client 0.12.1. Reinstalling Manager alone does not upgrade an existing Server. Retain the previous installation and backup separately: API 1 history/membership migration is unsupported and its backups must not be restored as API 2. Replacing/stopping Server interrupts calls. On Linux use the verified bundle and `manager/pawtalkctl` as documented; UAC/SYSTEM or root is needed only for the relevant host operations.

## Ограничения и файлы / Limitations and assets

Preview. Перенос неподписанных локальных сборок в новую Linux/CLI установку ограничен: сохраните исходный пакет. Проверки Windows SCM/UAC, Linux systemd, внешней сети и физических устройств зависят от среды; локальные проверки не заменяют всю матрицу CI. EXE без Authenticode.

Preview. Moving unsigned local builds to a fresh Linux/CLI installation is limited: retain the original package. Windows SCM/UAC, Linux systemd, external-network and physical-device acceptance depend on the environment; local checks do not replace the entire CI matrix. EXE has no Authenticode signature.

- `PawTalk.Server.Manager.Setup.0.5.1.exe`, `PawTalk.Manager.0.5.1.tar.gz`, `manager-manifest.json`.
- Verify the Manager Ed25519 trust root and manifest artifact sizes/SHA-256 / Проверяйте отдельный ключ Ed25519 Manager и размеры/SHA-256 из манифеста.
- [Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.5.1) · [CHANGELOG](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.5.1/CHANGELOG.md) · [Manager guide](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.5.1/docs/MANAGER-DESKTOP.md) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.5.1/LICENSE). Third-party notices remain included. Successful tag CI will be recorded only after it completes.
