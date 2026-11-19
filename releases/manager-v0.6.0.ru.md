# PawTalk Manager 0.6.0 — Terminal management on Linux and Windows

[English](manager-v0.6.0.en.md) · [Двуязычное описание](manager-v0.6.0.md)

Предварительный выпуск. Изменения относительно Manager 0.5.1.

[Windows GUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.6.0/PawTalk.Server.Manager.Setup.0.6.0.exe) · [Windows TUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.6.0/PawTalk.Server.Manager.TUI.Setup.0.6.0.exe) · [Linux](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.6.0/PawTalk.Manager.0.6.0.tar.gz)

### Добавлено

- Общий TUI с разделами для установки, запуска и остановки Server, настройки сети, обновлений, диагностики и резервных копий. Доступны выбор резервной копии и восстановление с подтверждением, навигация стрелками и мышью в поддерживаемых терминалах.
- Отдельный установщик Windows x64 с консольным хостом и встроенным Python, без Electron и трея. Тихая установка поддерживается через `/S`. При переходе с графической редакции сохраняются данные и конфигурация Server, а автообновление выбирает подписанный пакет установленной редакции.

### Установка и обновление

На Linux после установки Manager запустите `sudo pawtalkctl tui`. На Windows из PowerShell от имени администратора запустите выбранный установщик, на Server Core используйте `/S`. Затем выполните `& "$env:ProgramData\PawTalk Server Manager\pawtalkctl.exe" tui`. Для новой установки выберите «Обзор → Установить первый сервер». Server 0.13.0 обновляется отдельно.

### Ограничения

Возможности мыши зависят от терминала. Для управления службами нужны права администратора или root. Остановка и перезапуск Server прерывают активные звонки. EXE без Authenticode.

PawTalk.Server.Manager.Setup.0.6.0.exe · PawTalk.Server.Manager.TUI.Setup.0.6.0.exe · PawTalk.Manager.0.6.0.tar.gz · manager-manifest.json

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.6.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.6.0/LICENSE)
