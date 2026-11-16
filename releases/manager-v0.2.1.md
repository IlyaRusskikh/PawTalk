# PawTalk Manager 0.2.1 — Service control and settings fixes

Предварительный выпуск / Public preview.

**[Скачать для Windows x64 / Download for Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/manager-v0.2.1/PawTalk.Server.Manager.Setup.0.2.1.exe)**

## Русский

Исправлены ошибки управления службой, первое открытие настроек и переключение языка.

### Исправлено

- **Остановка службы.** Трей, настройки, смена пароля и удаление работают без включённой debug-привилегии администратора. Manager использует права управления службой и проверяет фактическое завершение процесса даже при отказе LocalService в SYNCHRONIZE.
- **Открытие настроек.** Окно видно с первого запуска из трея; повторное нажатие больше не требуется.
- **Язык сразу.** Выбор сохраняется без «Применить» и сразу переводит окно и трей, не применяя другие несохранённые поля.
- **Понятные ошибки.** Деинсталлятор показывает этап и код ошибки; интерактивные настройки ожидают краткую занятость обслуживания.

### Установка и обновление

Запустите EXE поверх текущего Manager от администратора. Конфигурация и данные сохраняются; замена host/runtime временно прерывает звонок. Уже установленный Server 0.10.1 менять не нужно. Для повторного входа в закладки установите также [Client 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.10.1). Забытый секрет E2EE нельзя восстановить из key ID: Manager хранит только отпечаток.

## English

Fix Windows service control, first settings launch and language switching.

### Fixed

- **Service stop:** tray controls, settings, password reset and uninstall no longer require enabled administrator debug privilege. Use service-control rights and verify actual process exit even when LocalService denies SYNCHRONIZE.
- **Settings launch:** show the window on the first tray launch, without needing a second click.
- **Immediate language:** persist the selection and translate the window/tray without Apply, preserving unrelated unsaved fields.
- **Clearer failures:** uninstall reports the failing phase/code; interactive settings wait for brief maintenance locks.

### Install or update

Run the EXE over the current Manager as administrator. Configuration/data are preserved; host/runtime replacement briefly interrupts calls. An installed Server 0.10.1 needs no replacement. Also install [Client 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.10.1) for saved-room reconnect fixes. A forgotten E2EE secret cannot be recovered from the stored key ID.

## Ограничения / Limitations

Это preview. Реальные микрофоны, игры/PTT/UAC, внешние сети и высокая нагрузка требуют отдельной приёмки; локальные проверки с синтетическим звуком её не заменяют. Приглашения, пароли и E2EE-секреты передавайте лично.

This is a preview. Physical microphones, games/PTT/UAC, external networks and load need separate acceptance; local synthetic-audio checks do not replace it. Share invitations, passwords and E2EE secrets privately.

Windows EXE не подписан Authenticode; подпись манифеста не является подписью издателя Windows. / The Windows EXE is not Authenticode-signed; the manifest signature is not a Windows publisher signature.

## Файлы, исходники и проверки / Assets, source and verification

- `PawTalk.Server.Manager.Setup.0.2.1.exe` — установщик Windows / Windows installer.
- `PawTalk.Manager.0.2.1.tar.gz` — bundle Manager / Manager bundle.
- `manager-manifest.json` — подписанные размеры и SHA-256 EXE/bundle / signed EXE and bundle sizes/hashes.

[Исходники этого выпуска / Corresponding source](https://github.com/IlyaRusskikh/PawTalk/tree/manager-v0.2.1) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[Changelog](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.2.1/CHANGELOG.md) · [Руководство / Guide](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.2.1/docs/WINDOWS-SERVER.md) · [Проверки / Verification record](https://github.com/IlyaRusskikh/PawTalk/blob/manager-v0.2.1/docs/VERIFICATION.md).

[Успешный выпускной CI / Successful tag workflow](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43172017294).
