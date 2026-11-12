# PawTalk Client 0.10.0 — Invitations, LAN connections and room privacy

Предварительный выпуск / Public preview.

**[Скачать для Windows x64 / Download for Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.10.0/PawTalk.Setup.0.10.0.exe)**

## Русский

Улучшены приглашения, подключение по локальной сети и работа с сохранёнными комнатами.

### Добавлено

- **Ввод приглашения.** Клиент принимает старый формат вставки из Manager и запрашивает недостающий пароль или E2EE-ключ.

### Исправлено

- **LAN-подключение.** Голос идёт через проверенный HTTPS-адрес комнаты и `/rtc`, без переадресации на недоступный публичный IP.
- **Закладки.** Одна проверенная комната объединяется при изменении приглашения или пароля; сохранённые данные обновляются после успешного входа.
- **Приватность активности.** Устаревшие данные доступа не заимствуют токен активной сессии и не раскрывают участников или непрочитанные сообщения.
- **Временные комнаты.** Закреплённый встроенный сервер получил исправление, запрещающее анонимный просмотр заполненности.

### Установка и обновление

Установите Client поверх текущей версии. Для защиты активности постоянной комнаты обязательно обновите сам [Server до 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.10.1): обновления клиента недостаточно. Для Windows доступен [Manager 0.2.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.0).

## English

Improved invitations, LAN connections and saved-room access.

### Added

- **Invitation entry:** accept the legacy Manager paste format and request a missing password or E2EE key.

### Fixed

- **LAN connections:** voice stays on the verified room HTTPS address through `/rtc`, rather than switching to an unreachable public IP.
- **Bookmarks:** deduplicate the same verified room across invitation/password changes; refresh saved credentials after successful login.
- **Activity privacy:** stale credentials cannot borrow the active session token or reveal participants/unread activity.
- **Temporary rooms:** the pinned embedded server includes the backport that denies anonymous occupancy requests.

### Install or update

Install over the existing client. Permanent rooms also require [Server 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.10.1) for server-side activity privacy; a client upgrade alone is insufficient. [Manager 0.2.0](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.2.0) is available for Windows.

## Ограничения / Limitations

При повторном входе в закладку иногда открывается пустая форма пароля/ключа. Это исправлено в [Client 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.10.1), а не в этой сборке. / Saved-room reconnects may intermittently open an empty credential form; this is fixed in Client 0.10.1, not this build.

Это preview. Реальные микрофоны, игры/PTT/UAC, внешние сети и высокая нагрузка требуют отдельной приёмки; локальные проверки с синтетическим звуком её не заменяют. Приглашения, пароли и E2EE-секреты передавайте лично.

This is a preview. Physical microphones, games/PTT/UAC, external networks and load need separate acceptance; local synthetic-audio checks do not replace it. Share invitations, passwords and E2EE secrets privately.

Windows EXE не подписан Authenticode; подпись манифеста не является подписью издателя Windows. / The Windows EXE is not Authenticode-signed; the manifest signature is not a Windows publisher signature.

## Файлы, исходники и проверки / Assets, source and verification

- `PawTalk.Setup.0.10.0.exe` — установщик / installer.
- [SHA256SUMS.txt](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.10.0/SHA256SUMS.txt) — SHA-256 точного EXE / exact installer hash.
- `update-manifest.json` — подписанный Ed25519 манифест / signed update manifest.
- [PawTalk.Licenses.0.10.0.zip](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.10.0/PawTalk.Licenses.0.10.0.zip) — LICENSE, THIRD_PARTY_NOTICES.md, licenses/.

[Исходники этого выпуска / Corresponding source](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.10.0) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[Changelog](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.10.0/CHANGELOG.md) · [Руководство / Guide](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.10.0/docs/COMPATIBILITY.md) · [Проверки / Verification record](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.10.0/docs/VERIFICATION.md).

[Успешный выпускной CI / Successful tag workflow](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43143215176).
