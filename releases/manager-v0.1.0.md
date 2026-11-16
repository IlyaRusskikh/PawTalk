# PawTalk Manager 0.1.0 — Server installation, backups and recovery

Предварительный выпуск / Public preview.

**[Скачать для Windows x64 / Download for Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.1.0/PawTalk.Server.Manager.Setup.0.1.0.exe)**

## Русский

Первый выпуск Server Manager для установки и обслуживания постоянного сервера Linux или Windows.

### Добавлено

- **Установка сервера.** Windows EXE с русским/английским мастером и нативными службами; на Linux — установка через Compose.
- **Проверяемые обновления.** Независимые версии и ключи доверия Server/Manager, проверка подписей и архивов до установки. В мастере шифрование и автообновления включены по умолчанию; обновления можно отключить.
- **Резервные копии и восстановление.** Согласованный backup с остановкой, обновление с проверкой здоровья и откатом конфигурации, данных и версии сервера.
- **Обслуживание.** Диагностика doctor, журнал незавершённых операций, восстановление после сбоя, ограниченные повторные запуски и обновление самого Manager без лишнего рестарта сервера.

### Исправлено

- Мастер проверяет ответы перед переходом дальше, корректно обрабатывает вставку и запрашивает key ID при включении E2EE.
- Windows-установщик ожидает дочернюю установку и сообщает её ошибку.

### Установка и обновление

Для Windows скачайте EXE Manager; для Linux используйте руководство сервера. Это первая версия Manager, отдельной миграции со Swarm нет. Секрет E2EE передаётся участникам лично: Manager получает только его SHA-256 key ID.

## English

The first Server Manager release for installing and maintaining persistent Linux or Windows servers.

### Added

- **Server setup:** a Russian/English Windows EXE wizard with native services; Compose installation on Linux.
- **Verified updates:** independent Server/Manager versions and trust roots; signatures and archives are checked before installation. Encryption and automatic updates default to enabled in the wizard and can be disabled.
- **Backup and restore:** stopped, consistent backups; health-checked updates with rollback of configuration, data and server version.
- **Maintenance:** doctor diagnostics, a durable operation journal, crash recovery, bounded restart attempts and Manager-only updates without unnecessary server restarts.

### Fixed

- The wizard validates answers before advancing, handles pasted input and requests a key ID whenever E2EE is enabled.
- Windows setup waits for the successor installer and reports its failure.

### Install or update

Use the Manager EXE on Windows and the server guide on Linux. This is the first Manager version; no Swarm migration is provided. Share the E2EE secret privately with participants; Manager takes only its SHA-256 key ID.

## Ограничения / Limitations

Трей и графические настройки появились позже, в Manager 0.2.0. Исправления управления Windows-службой доступны в [Manager 0.2.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.1). / Tray controls and graphical settings arrived in Manager 0.2.0; Windows service-control fixes are available in Manager 0.2.1.

Это preview. Реальные микрофоны, игры/PTT/UAC, внешние сети и высокая нагрузка требуют отдельной приёмки; локальные проверки с синтетическим звуком её не заменяют. Приглашения, пароли и E2EE-секреты передавайте лично.

This is a preview. Physical microphones, games/PTT/UAC, external networks and load need separate acceptance; local synthetic-audio checks do not replace it. Share invitations, passwords and E2EE secrets privately.

Windows EXE не подписан Authenticode; подпись манифеста не является подписью издателя Windows. / The Windows EXE is not Authenticode-signed; the manifest signature is not a Windows publisher signature.

## Файлы, исходники и проверки / Assets, source and verification

- `PawTalk.Server.Manager.Setup.0.1.0.exe` — установщик Windows / Windows installer.
- `PawTalk.Manager.0.1.0.tar.gz` — bundle Manager / Manager bundle.
- `manager-manifest.json` — подписанные размеры и SHA-256 EXE/bundle / signed EXE and bundle sizes/hashes.

[Исходники этого выпуска / Corresponding source](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.1.0) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[Changelog](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.1.0/CHANGELOG.md) · [Руководство / Guide](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.1.0/docs/WINDOWS-SERVER.md) · [Проверки / Verification record](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.1.0/docs/VERIFICATION.md) · [Полный diff / Full diff](https://github.com/IlyaRusskikh/PawTalk/compare/v0.8.0...manager-v0.1.0).
