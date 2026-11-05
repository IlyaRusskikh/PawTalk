# Changelog / История изменений

## Unreleased / Не выпущено

- Added real desktop screenshots and a static English/Russian project website
  with manual GitHub Pages publishing and link checks. / Добавлены скриншоты
  приложения и двуязычный сайт с ручной публикацией через GitHub Pages.
- Added a first-call guide, accessible address validation feedback, consistent
  invitation whitespace handling and actionable DNS/TCP timeout messages.
  / Добавлены руководство первого разговора, подсказки к адресу, обработка
  пробелов в приглашениях и уточнённая диагностика DNS/TCP/CGNAT.
- Windows CI now checks the built UI join flow, including invalid addresses and
  invitations copied with surrounding whitespace. / CI проверяет сценарии входа.

- Updated English/Russian READMEs for the published 0.1.0 preview: direct Windows
  download, first-room steps, use cases and FAQ. Added bilingual issue templates
  and a maintainer discoverability checklist. / Обновлены README после выпуска
  0.1.0, добавлены быстрый старт, FAQ, шаблоны issues и рекомендации по обнаружению проекта.

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
