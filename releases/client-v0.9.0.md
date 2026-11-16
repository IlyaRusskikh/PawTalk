# PawTalk Client 0.9.0 — Independent updates and server compatibility

Предварительный выпуск / Public preview.

**[Скачать для Windows x64 / Download for Windows x64](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.9.0/PawTalk.Setup.0.9.0.exe)**

## Русский

Клиент переходит на независимые обновления и сохраняет временные комнаты на Windows.

### Добавлено

- **Независимые обновления.** Клиент ищет выпуски `client-v*`, отдельно от Server и Manager, с проверкой семейства, канала и подписи.
- **Совместимость серверов.** Проверка версии API до входа; протокол 1 сохраняет подключение к старому Server 0.8.0.
- **Ключ E2EE.** Генератор показывает копируемый SHA-256 key ID для настройки сервера отдельно от секретного ключа участников.

### Исправлено

- Кнопка доступного обновления расположена над настройками в сайдбаре и не сдвигает страницу.
- Установщик ожидает завершения дочерней установки и передаёт её ошибку вместо преждевременного сообщения об успехе.

### Установка и обновление

При переходе с Client 0.8.0 сначала установите переходный [v0.8.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/v0.8.1), затем Client 0.9.0. Для ручного обновления полностью закройте клиент через трей и установите EXE поверх текущей версии. Временный сервер на Windows сохранён; этот установщик не устанавливает постоянную службу.

## English

Independent client updates while retaining temporary Windows rooms.

### Added

- **Independent updates:** discover `client-v*` releases separately from Server and Manager, validating family, channel and signature.
- **Server compatibility:** check the API protocol before login; protocol 1 retains support for Server 0.8.0.
- **E2EE key setup:** copy the SHA-256 key ID for the server separately from the participants’ secret.

### Fixed

- The available-update button sits above Settings without shifting page content.
- The installer waits for its successor and reports failures instead of declaring success early.

### Install or update

From Client 0.8.0, install the [v0.8.1 bridge](https://github.com/IlyaRusskikh/PawTalk/releases/tag/v0.8.1) first, then Client 0.9.0. For a manual upgrade, quit from the tray and install over the existing client. Temporary Windows hosting remains available; this installer does not install a permanent service.

## Ограничения / Limitations

Для приватности активности используйте актуальные Client и [Server 0.10.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.10.1); этот старый выпуск не включает последующее исправление. / For activity privacy use the updated Client and Server 0.10.1; this historical release does not include the later fix.

Это preview. Реальные микрофоны, игры/PTT/UAC, внешние сети и высокая нагрузка требуют отдельной приёмки; локальные проверки с синтетическим звуком её не заменяют. Приглашения, пароли и E2EE-секреты передавайте лично.

This is a preview. Physical microphones, games/PTT/UAC, external networks and load need separate acceptance; local synthetic-audio checks do not replace it. Share invitations, passwords and E2EE secrets privately.

Windows EXE не подписан Authenticode; подпись манифеста не является подписью издателя Windows. / The Windows EXE is not Authenticode-signed; the manifest signature is not a Windows publisher signature.

## Файлы, исходники и проверки / Assets, source and verification

- `PawTalk.Setup.0.9.0.exe` — установщик / installer.
- [SHA256SUMS.txt](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.9.0/SHA256SUMS.txt) — SHA-256 точного EXE / exact installer hash.
- `update-manifest.json` — подписанный Ed25519 манифест / signed update manifest.
- [PawTalk.Licenses.0.9.0.zip](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.9.0/PawTalk.Licenses.0.9.0.zip) — LICENSE, THIRD_PARTY_NOTICES.md, licenses/.

[Исходники этого выпуска / Corresponding source](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.9.0) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[Changelog](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.9.0/CHANGELOG.md) · [Руководство / Guide](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.9.0/docs/COMPATIBILITY.md) · [Проверки / Verification record](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.9.0/docs/VERIFICATION.md) · [Полный diff / Full diff](https://github.com/IlyaRusskikh/PawTalk/compare/v0.8.0...client-v0.9.0).
