# PawTalk Manager 0.3.0 — Desktop controls, live tray and Windows updates

Preview для Windows x64 и Linux / Preview for Windows x64 and Linux.

[Установщик Windows / Windows installer](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.3.0/PawTalk.Server.Manager.Setup.0.3.0.exe) · [Linux bundle](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.3.0/PawTalk.Manager.0.3.0.tar.gz).

## Русский

### Добавлено

- Отдельное окно управления: состояние службы, запуск и остановка, копирование пароля и приглашения, сеть, E2EE, история, обновления, резервные копии и диагностика. Доступны русский и английский языки.
- Трей показывает настоящее состояние службы цветом: зелёный — работает, жёлтый — переход, красный — остановлена. Скрытие убирает только значок; повторный запуск возвращает управление. Выход из Manager сначала останавливает Server.

### Исправлено

- Сохранение настроек остановленного сервера больше не запускает его. Новые параметры применяются при следующем запуске. Остановленное состояние сохраняется и при резервном копировании, восстановлении и обновлении Server.
- Операции ограничены по времени; окно можно скрыть во время работы. Конфликт с изменениями другого окна требует повторной загрузки настроек вместо перезаписи устаревшими данными.

### Изменено

- Manager проверяет обновления при старте и каждые десять минут, в том числе при выключенной автоустановке. Доступное обновление предлагается в окне и трее.
- Windows обновляет Manager полным установщиком: окно, Go host и контроллер обновляются вместе. Перед запуском проверяются подписанный манифест, версия, размер и SHA-256. При включённом автообновлении установщик запускается отдельной задачей SYSTEM без дополнительного подтверждения. Установка может прервать звонок. Linux сохраняет схему подписанных bundles.
- Обычный трей работает без повышения прав. Первое защищённое действие в окне, включая загрузку конфигурации, запрашивает UAC для отдельного посредника. Пароль и приглашение копируются прямо в системный буфер и не попадают в текст страницы или снимок настроек.

### Установка и обновление

В Windows установите новый EXE поверх текущего Manager. При переходе с 0.2.x нужен полный EXE: один Python bundle не доставляет новое окно и Go host. Данные комнаты, сертификат, пароль и настройки сохраняются; удаление данных при деинсталляции остаётся отдельным выбором. Планируйте перерыв: установка может остановить текущий звонок. Обновление сохраняет остановленное состояние сервера; следующий обычный запуск использует сохранённые настройки.

В Linux используйте штатное обновление Manager с подписанным `manager-manifest.json` и соответствующим bundle. Новое окно относится только к Windows. Установленные Server 0.10.1 и Client 0.11.0 обновлять ради этого Manager не требуется; установка Manager сама по себе не заменяет версию установленного Server. Схемы конфигурации и данных не меняются.

## English

### Added

- A dedicated management window for service status, start/stop, password and invitation copying, networking, E2EE, history, updates, backups and diagnostics, in Russian and English.
- The tray reflects actual service status: green for running, yellow for transitions and red for stopped. Hide removes only the icon; relaunching restores control. Exit Manager stops Server before closing.

### Fixed

- Saving settings while Server is stopped keeps it stopped; the next start uses the new settings. Backup, restore and Server updates also preserve stopped state.
- Operations have time limits and the window can be hidden while work continues. Concurrent configuration changes require a reload instead of overwriting newer settings with stale values.

### Changed

- Manager checks for updates at startup and every ten minutes, including when automatic installation is disabled. Available updates appear in the window and tray.
- Windows updates Manager through the complete installer, updating the window, Go host and controller together. Signed metadata, version, size and SHA-256 are checked before execution. With automatic updates enabled, a separate SYSTEM task runs the installer without another confirmation. Installation may interrupt a call. Linux retains signed-bundle updates.
- The ordinary tray runs without elevation. The window's first protected action, including configuration retrieval, requests UAC for a separate broker. Passwords and invitations go directly to the system clipboard, never into page text or settings snapshots.

### Install or update

On Windows, install the new EXE over the existing Manager. Upgrading from 0.2.x requires the complete EXE: a Python bundle alone does not deliver the new window and Go host. Room data, certificate, password and settings remain; removing data during uninstallation is still a separate choice. Plan a maintenance interruption: installation may stop the current call. Updating preserves a stopped server; its next ordinary start uses saved settings.

On Linux, use the existing Manager update mechanism with signed `manager-manifest.json` and its matching bundle. The new window is Windows-only. Installed Server 0.10.1 and Client 0.11.0 need no upgrade for this Manager; installing Manager does not itself replace the installed Server version. Configuration and data schemas are unchanged.

## Ограничения / Limitations

Это preview. Branch CI проверил настоящие SCM-службы, NSIS install/reinstall/uninstall, сохранность данных, UI/tray и Linux Compose lifecycle. Проверки подписей и хешей автообновления настоящие, запуск планировщика в fault-тестах подменён. Полная автоматическая установка задачей SYSTEM и автозапуск при входе требуют отдельной приёмки. Синтетический звук не подтверждает реальные микрофоны, игры/PTT, внешние сети и нагрузку.

This is a preview. Branch CI exercised actual SCM services, NSIS install/reinstall/uninstall, data preservation, UI/tray and Linux Compose lifecycle. Update signature/hash checks are real; fault tests substitute scheduler execution. Full unattended SYSTEM installation and login autostart require separate acceptance. Synthetic audio does not establish physical microphone, game/PTT, external-network or load acceptance.

EXE не подписан Authenticode; подпись манифеста не является подписью издателя Windows. / The EXE is not Authenticode-signed; the manifest signature is not a Windows publisher signature.

## Файлы, исходники и проверки / Assets, source and verification

- [PawTalk.Server.Manager.Setup.0.3.0.exe](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.3.0/PawTalk.Server.Manager.Setup.0.3.0.exe) — Windows x64 installer.
- [PawTalk.Manager.0.3.0.tar.gz](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.3.0/PawTalk.Manager.0.3.0.tar.gz) — общий Manager bundle с LICENSE и THIRD_PARTY_NOTICES.md / shared Manager bundle with LICENSE and THIRD_PARTY_NOTICES.md.
- [manager-manifest.json](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.3.0/manager-manifest.json) — доверенная Ed25519-подпись, SHA-256 и размер точных EXE/bundle; штатный updater проверяет их перед установкой / trusted Ed25519 signature, SHA-256 and size of the exact EXE/bundle, verified by the updater before installation. Для ручного сравнения хэша / manual hash comparison: `Get-FileHash .\PawTalk.Server.Manager.Setup.0.3.0.exe -Algorithm SHA256`.

[Исходники / Source](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.3.0) — AGPL-3.0-only; GitHub Source code ZIP/TAR соответствуют тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[CHANGELOG](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.3.0/CHANGELOG.md) · [Руководство Manager / Manager guide](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.3.0/docs/MANAGER-DESKTOP.md) · [Windows Server](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.3.0/docs/WINDOWS-SERVER.md) · [Совместимость / Compatibility](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.3.0/docs/COMPATIBILITY.md).

[Успешный branch CI / Successful branch CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43223509437). Выпускной tag workflow проверяется отдельно. / The release-tag workflow is verified separately.

[Успешный выпускной tag CI / Successful release-tag workflow](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43228717099) проверил и опубликовал этот Manager. / Verified and published this Manager.

После публикации проверены скачанные EXE/bundle, доверенная Ed25519-подпись, размеры, SHA-256, GitHub digest и содержимое bundle с исходниками и notices. / After publication, the downloaded EXE/bundle, trusted Ed25519 signature, sizes, SHA-256, GitHub digests and bundle source/notices were verified.
