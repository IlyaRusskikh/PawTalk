# PawTalk Manager 0.7.2 — Обновление Server в комнатах API 3

[English](manager-v0.7.2.en.md) · [Двуязычный источник](manager-v0.7.2.md)

Предварительный выпуск для Windows и Linux. Изменения относительно Manager 0.7.1.

[Windows GUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Server.Manager.Setup.0.7.2.exe) · [Windows TUI](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Server.Manager.TUI.Setup.0.7.2.exe) · [Linux](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.7.2/PawTalk.Manager.0.7.2.tar.gz)

### Исправлено

- Manager обновляет работающую комнату, уже переведённую на API 3, с Server 0.14.1 до подписанного Server 0.15.0. Перед фиксацией обновления проверяются переход на API 3 и TLS-идентичность комнаты. При сбое запуска или проверки Manager восстанавливает предыдущую версию Server вместе с данными комнаты.

### Установка и обновление

Сначала обновите Manager. В Linux выполните `sudo pawtalkctl manager now` или воспользуйтесь пунктом обновления Manager в TUI. В Windows используйте установщик для вашей редакции Manager. Затем при работающей комнате откройте **Обновления → Установить обновление Server** в TUI. Обновление прерывает текущие звонки.

## Ограничения

Для комнат, уже переведённых на API 3, этот способ обновления поддерживает опубликованные артефакты Server 0.15.0. Управление службой требует прав администратора или root. Файлы EXE не имеют подписи Authenticode.

## Файлы и исходники

PawTalk.Server.Manager.Setup.0.7.2.exe · PawTalk.Server.Manager.TUI.Setup.0.7.2.exe · PawTalk.Manager.0.7.2.tar.gz · manager-manifest.json

[Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.7.2) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.7.2/LICENSE)
