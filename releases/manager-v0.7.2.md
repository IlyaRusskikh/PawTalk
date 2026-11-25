# PawTalk Manager 0.7.2 — Server updates for API 3 rooms

Preview for Windows and Linux. Changes since Manager 0.7.1.
Предварительный выпуск для Windows и Linux. Изменения относительно Manager 0.7.1.

[Windows GUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Server.Manager.Setup.0.7.2.exe) · [Windows TUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Server.Manager.TUI.Setup.0.7.2.exe) · [Linux](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Manager.0.7.2.tar.gz)

## Русский

### Исправлено

- Manager обновляет работающую комнату, уже переведённую на API 3, с Server 0.14.1 до подписанного Server 0.15.0. Перед фиксацией обновления проверяются переход на API 3 и TLS-идентичность комнаты. При сбое запуска или проверки Manager восстанавливает предыдущую версию Server вместе с данными комнаты.

### Установка и обновление

Сначала обновите Manager. В Linux выполните `sudo pawtalkctl manager now` или воспользуйтесь пунктом обновления Manager в TUI. В Windows используйте установщик для вашей редакции Manager. Затем при работающей комнате откройте **Обновления → Установить обновление Server** в TUI. Обновление прерывает текущие звонки.

## English

### Fixed

- Manager can update a running room that has already migrated to API 3 from Server 0.14.1 to the signed Server 0.15.0 release. It verifies the active cutover and TLS identity before committing the update. If startup or verification fails, Manager restores the previous Server artifact and room data together.

### Install or update

Update Manager first. On Linux, run `sudo pawtalkctl manager now` or use the Manager update action in the TUI. On Windows, use the installer for your Manager edition. Then open **Updates → Install Server update** in the TUI, with the room running. The update interrupts active calls.

## Ограничения / Limitations

Для комнат, уже переведённых на API 3, этот способ обновления поддерживает опубликованные артефакты Server 0.15.0. Управление службой требует прав администратора или root. Файлы EXE не имеют подписи Authenticode.

For rooms already using API 3, this update path accepts the published Server 0.15.0 artifacts. Service management requires administrator or root privileges. Windows EXEs have no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Server.Manager.Setup.0.7.2.exe · PawTalk.Server.Manager.TUI.Setup.0.7.2.exe · PawTalk.Manager.0.7.2.tar.gz · manager-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.7.2) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.7.2/LICENSE)
