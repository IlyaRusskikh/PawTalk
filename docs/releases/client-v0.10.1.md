# PawTalk Client 0.10.1 — Reliable saved-room reconnects

Предварительный выпуск / Public preview.

**[Скачать для Windows x64 / Download for Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.10.1/PawTalk.Setup.0.10.1.exe)**

## Русский

Исправлен повторный вход в сохранённые комнаты, когда клиент иногда открывал пустую форму пароля и ключа.

### Исправлено

- **Повторный вход.** Устаревший статус предпросмотра больше не открывает форму: клиент сначала пробует сохранённые пароль и E2EE-ключ.
- **Запрос данных.** Форма появляется после реального отказа авторизации; уже сохранённые поля подставлены. Ошибка сети не выдаётся за неверные данные доступа.
- **Сохранение и предпросмотр.** Пароль и ключ читаются/сохраняются совместно; запоздавший ответ preview не подменяет обновлённый доступ и не раскрывает активность после удаления данных доступа.

### Установка и обновление

Полностью закройте клиент через трей и установите EXE поверх текущей версии. Для исправлений управления Windows-службой установите также [Manager 0.2.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.1). Уже установленный Server 0.10.1 менять не нужно.

## English

Fix intermittent empty password/key prompts when reconnecting to saved rooms.

### Fixed

- **Reconnects:** a stale locked preview no longer opens the login form; try the saved password and E2EE key first.
- **Credential prompts:** prompt after actual authorization rejection, prefill saved fields and keep network failures distinct from invalid credentials.
- **Storage and previews:** read/write the password/key pair together; late preview responses cannot overwrite refreshed access or reveal activity after credentials are removed.

### Install or update

Quit the client from the tray and install over the current version. For Windows service-control fixes also install [Manager 0.2.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.1). An installed Server 0.10.1 needs no replacement.

## Ограничения / Limitations

Это preview. Реальные микрофоны, игры/PTT/UAC, внешние сети и высокая нагрузка требуют отдельной приёмки; локальные проверки с синтетическим звуком её не заменяют. Приглашения, пароли и E2EE-секреты передавайте лично.

This is a preview. Physical microphones, games/PTT/UAC, external networks and load need separate acceptance; local synthetic-audio checks do not replace it. Share invitations, passwords and E2EE secrets privately.

Windows EXE не подписан Authenticode; подпись манифеста не является подписью издателя Windows. / The Windows EXE is not Authenticode-signed; the manifest signature is not a Windows publisher signature.

## Файлы, исходники и проверки / Assets, source and verification

- `PawTalk.Setup.0.10.1.exe` — установщик / installer.
- [SHA256SUMS.txt](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.10.1/SHA256SUMS.txt) — SHA-256 точного EXE / exact installer hash.
- `update-manifest.json` — подписанный Ed25519 манифест / signed update manifest.
- [PawTalk.Licenses.0.10.1.zip](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.10.1/PawTalk.Licenses.0.10.1.zip) — LICENSE, THIRD_PARTY_NOTICES.md, licenses/.

[Исходники этого выпуска / Corresponding source](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.10.1) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[Changelog](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.10.1/CHANGELOG.md) · [Руководство / Guide](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.10.1/docs/COMPATIBILITY.md) · [Проверки / Verification record](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.10.1/docs/VERIFICATION.md).

[Успешный выпускной CI / Successful tag workflow](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43172017460).
