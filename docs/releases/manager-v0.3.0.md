# PawTalk Server Manager 0.3.0

Подготовка, ещё не опубликовано / Prepared, not yet published.

## Русский

По сравнению с Manager 0.2.1 добавлено отдельное окно Electron/React: управление
службой, копирование пароля и ссылки входа, сеть, E2EE, история, обновления,
резервные копии и диагностика. Русский и английский интерфейс согласованы.
Компактный трей показывает настоящее состояние службы цветом. Выход останавливает
сервер, скрытие убирает только значок, повторный запуск возвращает управление.

Исправлено сохранение настроек остановленного сервера: оно больше не запускает
сервер и не оставляет старое окно в бесконечном применении. Операции ограничены
по времени, конфликты настроек требуют повторной загрузки. Остановленное состояние
сохраняется при резервном копировании, восстановлении и обновлении Server.

Обновления Manager проверяются при старте и периодически. Автообновление использует
полный Windows установщик с проверкой подписи метаданных, размера и SHA-256 без
дополнительного подтверждения; если оно выключено, обновление предлагается в трее
и окне. Установка может прервать звонок. Первое защищённое действие в окне требует
UAC; обычный запуск трея не требует повышения прав.

Планируемый файл: `PawTalk.Server.Manager.Setup.0.3.0.exe`. До публикации
используйте [опубликованный Manager 0.2.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.1).
Данные, сертификат и пароль сохраняются при обновлении существующей установки.
Перед публикацией обязательна проверка настоящих служб и установки от SYSTEM
в чистой Windows VM; ограничения и команды проверки описаны в
[руководстве](../MANAGER-DESKTOP.md).

## English

Since Manager 0.2.1, a dedicated Electron/React window adds service controls,
password/invitation copying, networking, E2EE, history, updates, backups and
diagnostics, with consistent Russian/English interfaces. The compact tray uses
actual service status and colored icons. Exit stops the server; hide removes
only the icon, and relaunching restores control.

Saving settings while the server is stopped now keeps it stopped instead of
starting it or leaving the old window applying settings indefinitely. Operations
have time limits and configuration conflicts require a reload. Backup, restore
and Server updates also preserve the stopped state.

Manager checks for updates at startup and periodically. Automatic updates use
the complete Windows installer after checking signed metadata, size and SHA-256,
without another confirmation. When disabled, installation is offered in the
tray/window. Installation may interrupt a call. The first protected window
operation requests UAC; ordinary tray startup does not elevate.

Planned file: `PawTalk.Server.Manager.Setup.0.3.0.exe`. Until publication use
[published Manager 0.2.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.1).
Upgrades preserve data, certificate and password. Actual services and installation
as SYSTEM must be verified on a clean Windows VM before publication; see the
[guide](../MANAGER-DESKTOP.md) for checks and limitations.

Exact downloads, checksums and the immutable source tag will be added when the
release candidate is approved and published. No 0.3.0 download is available yet.
