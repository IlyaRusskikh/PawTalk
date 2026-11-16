# PawTalk Manager 0.2.0 — Windows tray, settings and ProgramData setup

Предварительный выпуск / Public preview.

**[Скачать для Windows x64 / Download for Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.2.0/PawTalk.Server.Manager.Setup.0.2.0.exe)**

## Русский

Управление постоянным Windows-сервером через трей и окно настроек; обновлённая установка и удаление.

### Добавлено

- **Трей сервера.** Запуск, остановка и выход, копирование приглашения и смена пароля; отдельный серверный значок, ярлык на рабочем столе и запуск трея при входе.
- **Настройки сервера.** Изменение текущих параметров мастера, раздельные автообновления Server/Manager, backup и проверка здоровья с откатом при неудаче. Смена IP требует Server 0.10.1.
- **Полное удаление по выбору.** Чекбокс удаления настроек и данных; без него данные комнаты сохраняются.

### Исправлено

- **Установка в ProgramData.** Защищённые общие папки, миграция из Program Files и повторное использование имеющегося конфига без повторных вопросов.
- **Приглашение и пароль.** Приглашение показывается один раз в мастере без дублирующей консоли; сохранённый пароль защищён пользовательским DPAPI.
- Повторная установка ждёт завершения служб и удаления записи SCM; приглашения кратко ожидают стартовое обслуживание, временные ошибки скачивания повторяются.

### Установка и обновление

Запустите EXE поверх текущего Manager от администратора. Конфигурация и данные сохраняются, замена служб временно прерывает звонок. Переустановка Manager сохраняет версию Server: для защиты активности отдельно обновите Server до 0.10.1. Manager хранит key ID E2EE, а не исходный секрет участников.

## English

Windows server tray controls, a settings window and improved installation/removal.

### Added

- **Server tray:** start/stop/exit, invitation copying and password reset; a distinct server badge, desktop shortcut and tray launch at sign-in.
- **Server settings:** edit setup parameters and independent Server/Manager auto-update preferences, with backup, health verification and rollback. IP changes require Server 0.10.1.
- **Optional full uninstall:** a checkbox removes settings/data; otherwise room data is preserved.

### Fixed

- **ProgramData installation:** protected shared directories, migration from Program Files and reuse of existing configuration without repeating setup questions.
- **Invitation/password:** show the invitation once in setup without a duplicate console; protect the recoverable password with per-user DPAPI.
- Reinstallation waits for service exit and pending SCM deletion; invitation requests briefly wait for startup maintenance and transient downloads retry.

### Install or update

Run the EXE over the existing Manager as administrator. Configuration/data are preserved; service replacement briefly interrupts calls. Reinstallation preserves the Server version, so upgrade Server separately to 0.10.1 for activity privacy. Manager stores the E2EE key ID, not the participants’ original secret.

## Ограничения / Limitations

Управление службой может завершаться ошибкой прав, настройки — требовать второго открытия; язык применяется только после подтверждения. Эти проблемы исправлены в [Manager 0.2.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.1). / Service operations may fail on permissions, settings may need a second launch and language requires Apply. These issues are fixed in Manager 0.2.1.

Это preview. Реальные микрофоны, игры/PTT/UAC, внешние сети и высокая нагрузка требуют отдельной приёмки; локальные проверки с синтетическим звуком её не заменяют. Приглашения, пароли и E2EE-секреты передавайте лично.

This is a preview. Physical microphones, games/PTT/UAC, external networks and load need separate acceptance; local synthetic-audio checks do not replace it. Share invitations, passwords and E2EE secrets privately.

Windows EXE не подписан Authenticode; подпись манифеста не является подписью издателя Windows. / The Windows EXE is not Authenticode-signed; the manifest signature is not a Windows publisher signature.

## Файлы, исходники и проверки / Assets, source and verification

- `PawTalk.Server.Manager.Setup.0.2.0.exe` — установщик Windows / Windows installer.
- `PawTalk.Manager.0.2.0.tar.gz` — bundle Manager / Manager bundle.
- `manager-manifest.json` — подписанные размеры и SHA-256 EXE/bundle / signed EXE and bundle sizes/hashes.

[Исходники этого выпуска / Corresponding source](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.2.0) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[Changelog](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.2.0/CHANGELOG.md) · [Руководство / Guide](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.2.0/docs/WINDOWS-SERVER.md) · [Проверки / Verification record](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.2.0/docs/VERIFICATION.md).

[Успешный выпускной CI / Successful tag workflow](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43143103343).
