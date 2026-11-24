# PawTalk Manager 0.7.1 — Windows GUI startup fix

Preview. Changes since Manager 0.7.0.
Предварительный выпуск. Изменения относительно Manager 0.7.0.

[Windows GUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.1/PawTalk.Server.Manager.Setup.0.7.1.exe) · [Windows TUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.1/PawTalk.Server.Manager.TUI.Setup.0.7.1.exe) · [Linux](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.1/PawTalk.Manager.0.7.1.tar.gz)

## Русский

### Исправлено

- Установленный Windows GUI находит служебные программы Manager в каталоге установки. Исправлены недоступный статус службы и ошибочное сообщение о нехватке прав при открытии окна.

### Установка и обновление

Обновите установленную редакцию Manager. Для Windows GUI используйте графический установщик. Server обновляется отдельно.

## English

### Fixed

- The installed Windows GUI finds its Manager host programs in the installation directory, fixing unavailable service status and a misleading administrator-permission error when opening the window.

### Install or update

Update the installed Manager edition. Use the graphical installer for Windows GUI. Server updates independently.

## Ограничения / Limitations

Управление службой требует прав администратора или root. EXE без Authenticode.

Service management requires administrator or root privileges. The EXEs have no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Server.Manager.Setup.0.7.1.exe · PawTalk.Server.Manager.TUI.Setup.0.7.1.exe · PawTalk.Manager.0.7.1.tar.gz · manager-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.7.1) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.7.1/LICENSE)
