# Changelog / История изменений

## Unreleased / Не выпущено

## 0.2.0 — 2026-11-05 — Languages and verified updates / Языки и обновления

- Added English/Russian language selection in the installer and Settings, with translated screens, tray and connection-quality tooltips. / Добавлены выбор языка установщика и приложения, перевод экранов, трея и качества связи.
- Added a local server E2EE key/hash/.env generator and an in-app internet-hosting check using the standalone preflight script. / Добавлены генератор ключа E2EE для сервера и проверка хостинга из приложения через общий скрипт.
- Added startup GitHub release checks including pre-releases, deferral with a top-right icon, SHA-256 verified downloads, NSIS replacement and preserved profile. / Добавлено автообновление из GitHub с отложенной установкой, проверкой файла и сохранением профиля.
- Added a separate installation-status window with elapsed time, helper readiness and application-startup confirmation. Fixed Windows PowerShell handoff so the app opens after installation; failures retain the installer and logs. / Добавлено окно статуса, исправлена передача управления установщику и проверяется запуск новой версии.
- Fixed the user dock overlapping bookmarks. Participant mute/deafen states use crossed-out icons and speaking uses highlighting. Shared RTT colors: green <150 ms, yellow 150–299 ms, red ≥300 ms, gray without data. / Исправлены положение профиля, иконки состояний и цвета пинга.
- Fixed key/hash/.env copying through Electron clipboard IPC and shared 20px form spacing, including conditional E2EE fields. Aligned modal action buttons and documented UI rules. / Исправлены копирование ключа, отступы полей и выравнивание кнопок.
- Improved hosting checks with retries, physical-adapter preference, per-port results and specific failure reasons; removed an unrelated port reservation. / Улучшены повторы, выбор адаптера и диагностика сетевой проверки.
- Refreshed bilingual documentation, first-call instructions, website screenshots and release links. Removed the temporary update demo and its tooling; retained production regression tests. / Обновлены документация, сайт и скриншоты; демо и временный инструментарий удалены.

## 0.1.0 — 2026-11-05 — Initial release / Первый выпуск

- Added a step-by-step Linux VPS guide with Docker installation links, host and
  container permissions, public GHCR image deployment, ports and operations.
- Added a prebuilt-image Compose file, configuration example and GHCR publishing
  after successful release-tag checks. / Добавлены установка готового образа,
  пример настроек и публикация в GHCR после проверок релизного тега.
- Server images include Linux amd64 and arm64 under one tag, with native CI
  lifecycle checks for both architectures. / Мультиплатформенный серверный образ
  amd64/arm64 и отдельные нативные проверки обеих архитектур в CI.

- Windows desktop voice client with voice activation, push-to-talk, device and
  volume controls, local RNNoise processing, tray and global shortcuts.
- Built-in temporary rooms, pinned TLS invitations and optional port mapping.
- Persistent self-hosted Go/LiveKit server and Docker Compose deployment.
- Optional experimental end-to-end encryption and protected password storage.
- Source, build scripts, automated checks, English/Russian READMEs and AGPL-3.0-only license.

Состав: Windows-клиент, локальная обработка звука, встроенные комнаты,
постоянный сервер, экспериментальное E2EE, исходники и инструкции сборки.
Ограничения и непроверенные сценарии: [README.ru.md](README.ru.md).
