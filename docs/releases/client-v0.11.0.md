# PawTalk Client 0.11.0 — First-run setup, shared server core and responsive sounds

Preview для Windows x64 / Preview for Windows x64.

[Скачать установщик / Download installer](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.11.0/PawTalk.Setup.0.11.0.exe).

## Русский

### Добавлено

- Мастер первого запуска: язык, никнейм, аватар и проверка микрофона. Настройку можно отложить или продолжить после перезапуска.
- Новые записи Мани, кошки автора проекта, для сообщений и комнаты; звуки переключения микрофона и входящего звука.

### Исправлено

- Новое сообщение запускает звук сразу, а предыдущий плавно затихает за 120 мс. Вход/выход не пропускается при серии уведомлений; тихое начало этих записей пропускается при воспроизведении.
- Ошибки создания/закрытия комнаты и проверки сети показываются на выбранном языке без служебной обёртки Electron. Повторная попытка очищает прежнюю ошибку.
- Прокрутка настроек и расположение кнопок обновления; предложение обновления можно повторно открыть из настроек, в том числе после неудачной установки.

### Изменено

- Встроенная временная комната собирается из того же текущего `server/`, что и постоянный Windows Server. Отдельный старый pin и backport больше не поддерживаются в новых сборках. Проверка сравнивает Go/LiveKit-бинарники побайтово и сверяет хэши с receipt.

### Установка и обновление

Полностью закройте Client через трей и установите новый EXE поверх текущей версии. Настройки и закладки сохраняются; первый запуск предлагает мастер новым профилям. Выход хоста закрывает временную комнату; после её пересоздания передайте новое приглашение. Постоянный Server 0.10.1 и Manager 0.2.1 обновлять ради этого Client не требуется. Новое встроенное ядро доставляется именно с Client, а не отдельным обновлением Server.

## English

### Added

- First-run language, nickname, avatar and microphone setup. Defer setup or resume it after restarting.
- New recordings of the project owner's cat Manya for messages and rooms, plus microphone/incoming-audio toggle cues.

### Fixed

- New messages start a cue immediately and fade the previous one over 120 ms. Room entry/exit cues are not dropped during message bursts; playback skips their quiet lead-ins.
- Hosting and network-check errors use the selected language without Electron's internal error wrapper. Retry clears the previous failure.
- Settings scrolling and update action layout; reopen an update offer from settings, including after a failed installation.

### Changed

- Temporary rooms build the same current `server/` core as permanent Windows Server. New builds no longer maintain the separate legacy pin/backport. Verification compares Go/LiveKit binaries byte for byte and checks receipt hashes.

### Install or update

Quit Client from its tray and install over the current version. Settings/bookmarks remain; new profiles receive the setup guide. Quitting the host closes its temporary room; share a new invitation after recreating it. Permanent Server 0.10.1 and Manager 0.2.1 require no upgrade for this Client. The new embedded core arrives with Client, not a separate Server update.

## Ограничения и файлы / Limitations and assets

Preview. Синтетические аудиотесты не заменяют реальные микрофоны, игры/PTT, внешнюю сеть и нагрузку. EXE не подписан Authenticode; Ed25519-манифест и SHA-256 не заменяют подпись издателя Windows.

Preview. Synthetic audio tests do not establish physical microphone, game/PTT, external-network or load acceptance. The EXE is not Authenticode-signed; the Ed25519 manifest and SHA-256 do not replace a Windows publisher signature.

- [PawTalk.Setup.0.11.0.exe](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.11.0/PawTalk.Setup.0.11.0.exe) — установщик / installer.
- [SHA256SUMS.txt](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.11.0/SHA256SUMS.txt) — SHA-256 точного EXE / exact installer hash. Проверка / verify: `Get-FileHash .\PawTalk.Setup.0.11.0.exe -Algorithm SHA256`.
- [update-manifest.json](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.11.0/update-manifest.json) — подписанный Ed25519 манифест для Client updater / signed Ed25519 manifest for the Client updater.
- [PawTalk.Licenses.0.11.0.zip](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.11.0/PawTalk.Licenses.0.11.0.zip) — LICENSE, THIRD_PARTY_NOTICES.md, licenses/.

[Исходники / Source](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.11.0) — AGPL-3.0-only; GitHub Source code ZIP/TAR относятся к этому тегу. Сторонние компоненты сохраняют свои лицензии / third-party components retain their licenses.

[CHANGELOG](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.11.0/CHANGELOG.md) · [Совместимость / Compatibility](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.11.0/docs/COMPATIBILITY.md) · [Встроенный сервер / Bundled server](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.11.0/docs/BUNDLED-SERVER.md).

[Успешный branch CI / Successful branch CI](https://github.com/IlyaRusskikh/PawTalk/actions/runs/43210048330) проверил исходный кандидат, включая Windows 2022/2025 и Linux/Docker. Выпускной tag workflow выполняется отдельно; этот branch run не подтверждает публикацию. / This branch run verified the original candidate, including Windows 2022/2025 and Linux/Docker. The release-tag workflow runs separately; this branch run does not establish publication.
