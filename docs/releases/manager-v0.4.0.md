# PawTalk Manager 0.4.0 — First-open fix and local Server packages

Preview candidate for Windows x64 and Linux. Not published yet.
Предварительная версия для Windows x64 и Linux. Ещё не опубликована.

## Русский

### Добавлено

- Установка Windows Server из локального ZIP или переносимого пакета без соединения с GitHub. До установки показаны версия, SHA-256 и результат проверки подписи. Неподписанная локальная сборка требует подтверждения, хранится отдельно от опубликованных бинарников и может иметь тот же номер версии. Перед заменой создаётся резервная копия; неудачный запуск откатывается.
- Удаление выбранной резервной копии прямо в интерфейсе. Подтверждение показывает дату и имя; список обновляется сразу. Копии, необходимые незавершённому восстановлению, и небезопасные пути не удаляются.
- Отдельная проверка доступности обновлений Server перед предложением установки.

### Исправлено

- Первое открытие окна из трея двойным кликом или командой настроек больше не требует повторного вызова. Windows-запуск GUI и его перезапуск после обновления не подавляют первый показ окна флагом SW_HIDE.
- Загрузка настроек больше не обрывается при сохранении публичного статуса в каталоге программы: для него применяется отдельная политика доступа, без раскрытия приватной конфигурации.
- Сетевые проверки обновлений не удерживают блокировку комнаты. Чтение настроек, журнала и диагностика доступны во время обслуживания; создание копии возвращает обновлённый список тем же ответом.

### Изменено

- Приглашение удалено из установщика; пароль и приглашение копируются в разделе «Обзор» Manager.
- Ручная проверка Manager не запускает установку автоматически. Время интерактивной проверки ограничено; её индикатор остаётся на вкладке «Обновления».
- После успешной установки неподписанной локальной сборки автообновление Server выключается, чтобы фоновая служба не заменила тестовый бинарник опубликованным. Его можно включить обратно в интерфейсе.

### Установка и обновление

В Windows установите `PawTalk.Server.Manager.Setup.0.4.0.exe` поверх текущего Manager. Настройки, идентичность, история и копии сохраняются. Замена файлов служб может прервать звонок. Версии Client и Server не меняются автоматически; функции локальных пакетов и графического окна относятся к Windows. Linux сохраняет консольный Manager и подписанные bundles.

Для опубликованного локального Server ZIP положите его `server-manifest.json` рядом либо включите в переносимый пакет. Неверная подпись не заменяется установкой без подписи. Для пакета без манифеста подтверждение пользователя означает доверие к выбранному коду; SHA-256 сам по себе не подтверждает автора.

### Ограничения

Локальные сборки не поддерживают перенос резервной копии в новую установку через Linux/CLI; сохраняйте исходный пакет. Начальная установка Manager по-прежнему использует опубликованные подписанные зависимости. EXE не имеет заявленной Authenticode-подписи. Внешняя сеть, физические аудиоустройства и запуск задачи автоустановки SYSTEM не считаются проверенными локальными синтетическими тестами. CI тега 0.4.0 ещё не запускался.

## English

### Added

- Offline installation of Windows Server ZIPs and portable packages, showing version, SHA-256 and signature status before approval. Unsigned local builds require confirmation, use separate binary directories and may reuse a version number. Installation backs up the room and rolls back failed starts.
- Delete individual backups in the UI with date/name confirmation and an immediate refreshed list. Pending recovery sources and unsafe paths cannot be deleted.
- Check Server availability before offering an update installation.

### Fixed

- The first tray double-click or Settings command opens the window without another request. GUI startup and restart after updates no longer suppress the first show through Windows SW_HIDE.
- Loading settings no longer fails when publishing public status in the installation directory. Status uses a separate access policy without exposing private configuration.
- Metadata requests do not hold the room lock. Settings, logs and diagnostics remain readable during maintenance; backup creation returns its refreshed list in the same response.

### Changed

- The installer no longer displays invitations. Copy invitations/passwords from Manager Overview.
- Manual Manager checks do not trigger installation. Interactive checks have time limits and their progress stays on Updates.
- Successfully installing an unsigned local build disables Server auto-updates so maintenance does not replace the test binary. Re-enable them in the UI when desired.

### Installation and upgrade

Install `PawTalk.Server.Manager.Setup.0.4.0.exe` over the existing Windows Manager. Configuration, identity, history and backups are retained; replacing service files may interrupt a call. Client and Server versions do not change automatically. Local packages and the graphical window are Windows features; Linux retains its console Manager and signed bundles.

For published Server ZIPs, place `server-manifest.json` beside the ZIP or include it in the portable package. Invalid signatures never fall back to unsigned installation. Approving a package without a manifest explicitly trusts the selected code; a checksum alone does not establish authorship.

### Limitations

Local-build backup migration to a fresh installation through Linux/CLI is unsupported; keep the original package. Initial Manager setup still needs its published signed dependencies. No Authenticode signature is claimed for the EXE. Local synthetic tests do not establish external-network, physical-device or SYSTEM auto-installer coverage. The 0.4.0 tag workflow has not run.

## Planned files and source / Планируемые файлы и исходники

After publication / После публикации:

- Windows: `PawTalk.Server.Manager.Setup.0.4.0.exe`.
- Linux/shared controller: `PawTalk.Manager.0.4.0.tar.gz`.
- Verification: `manager-manifest.json`, component Ed25519 trust roots and declared artifact sizes/SHA-256.
- Source: tag `manager-v0.4.0`, including `CHANGELOG.md`, `docs/MANAGER-DESKTOP.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` and license notices.

These artifacts/tag are not published yet. Existing 0.3.0 files and release notes remain unchanged. / Эти файлы и тег ещё не опубликованы. Опубликованные файлы и заметки 0.3.0 не меняются.
