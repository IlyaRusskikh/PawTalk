# Changelog / История изменений

## Unreleased / Не выпущено

- Added a step-by-step Linux VPS guide with Docker installation links, host and
  container permissions, public GHCR image deployment, ports and operations.
- Added a prebuilt-image Compose file, configuration example and GHCR publishing
  after successful release-tag checks. / Добавлены установка готового образа,
  пример настроек и публикация в GHCR после проверок релизного тега.
- Server images include Linux amd64 and arm64 under one tag, with native CI
  lifecycle checks for both architectures. / Мультиплатформенный серверный образ
  amd64/arm64 и отдельные нативные проверки обеих архитектур в CI.

## 0.1.0 — Initial release / Первый выпуск

Prepared for publication; the Git tag and GitHub Release mark the actual release.
Подготовлено к публикации; фактический выпуск отмечается Git-тегом и GitHub Release.

- Windows desktop voice client with voice activation, push-to-talk, device and
  volume controls, local RNNoise processing, tray and global shortcuts.
- Built-in temporary rooms, pinned TLS invitations and optional port mapping.
- Persistent self-hosted Go/LiveKit server and Docker Compose deployment.
- Optional experimental end-to-end encryption and protected password storage.
- Source, build scripts, automated checks, English/Russian READMEs and AGPL-3.0-only license.

Состав: Windows-клиент, локальная обработка звука, встроенные комнаты,
постоянный сервер, экспериментальное E2EE, исходники и инструкции сборки.
Ограничения и непроверенные сценарии: [README.ru.md](README.ru.md).
