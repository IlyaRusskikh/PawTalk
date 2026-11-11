# Проверки

## 0.9.0 — локальная подготовка к ревью, 11 ноября 2026

135 JS tests без пропусков, 22 Python tests, TypeScript/Vite, Go test/vet/race,
native/Electron/UI, NSIS и packaged smoke прошли локально. Compose проверен в
Debian 12 / Ubuntu 24.04 userspace с настоящим Docker, локальным registry и
временными ключами: backup/restore, неисправный rollout, настоящий SIGKILL,
Manager-only без рестарта и сохранение E2EE policy/opaque history.
Карта файлов, методы проверки и ограничения: [IMPLEMENTATION-0.9.0](IMPLEMENTATION-0.9.0.md).
GitHub Actions, native arm64, настоящий VPS/внешние сети и физические устройства
не объявляются проверенными. Push, release tags и публикации не выполнялись.

## PawTalk 0.7.1 — 9 ноября 2026

- Added mixed-case GitHub owner/repository regression coverage in the updater and server redirect allowlist. Foreign repositories, changed tags, credentials and unsupported URLs remain rejected.
- Read-only live Electron/net.fetch verification discovered the published 0.7.0 release from a simulated 0.6.0 client and verified its actual Ed25519-signed manifest. No installer was launched. After publishing 0.7.1, repeat with PAWTALK_UPDATE_TEST_CURRENT=0.7.0 to verify discovery of this fix.
- Both Docker images and Compose validation passed. The container lifecycle/TLS/auth/persistence smoke passed on ports 39443–39445; the usual test UDP port 31445 was occupied by another local process.
- Clean dependency installation, LLVM native build/smoke, production build, all 114 JavaScript tests, six Python updater tests, Go race tests/vet, NSIS packaging and packaged executable smoke passed locally.
- Built-renderer motion/navigation/geometry, UI flow, update UI, native clipboard, realtime two-client voice, paged chat, main-process attachments/mutations, formatting/deletion, sounds and external links passed. Audio uses synthetic microphones; hardware/external-network/UAC/load acceptance remains outstanding. Native Linux amd64/arm64 and signed release artifacts are checked by the tag workflow.


## PawTalk 0.7.0 — 9 ноября 2026

- Windows: clean dependency install, LLVM native build/smoke, production renderer, NSIS installer and packaged executable smoke passed. The packaged smoke waits for the preload bridge before invoking IPC.
- All 113 JavaScript tests and six Python updater tests passed. Go race tests and go vet passed with Go 1.27.3 and the local LLVM C compiler.
- Built-renderer navigation/geometry/motion, UI flow, update UI, native clipboard IPC, two-client realtime, paged chat, main-process image/mutation flows, inline formatting/deletion, notification playback and external-link checks passed.
- Fourteen RU/EN screenshots were captured from isolated real Electron main/preload/renderer sessions with demo participants and synthetic microphones, including the new Sounds section. Reviewed all images; no live invitations or personal data are shown. Website links, metadata and image bounds passed the site guard.
- Both Docker images built successfully; Compose configurations and the read-only non-root server lifecycle/TLS/auth/persistence smoke passed locally.
- Tests use synthetic microphones/transports where stated. Real microphones, game/PTT behavior, separate internet networks, UAC and hardware load remain outside this local verification. Native Linux amd64/arm64 and final signed release artifacts are verified by the tag workflow.


## PawTalk 0.2.0 — 5 ноября 2026

- Production build, Windows NSIS packaging, 72 JS tests, Go tests/vet, native smoke,
  renderer/UI regression checks and two local WebRTC clients with synthetic audio.
  / Сборка, Windows NSIS, 72 JS-проверки, Go tests/vet, native smoke, UI-сценарии
  и два локальных WebRTC-клиента с синтетическим звуком.
- Russian/English screenshots captured from the real main/preload/renderer in an
  isolated profile. No room, live invitation, recording or personal network data
  is included. Conditional E2EE fields retain 20px gaps at widths 940/1100;
  SDK quality labels and RTT colors checked in both languages.
- Clipboard key/hash/.env IPC checked with browser clipboard denied. The native
  clipboard sink is mocked in that regression test to preserve the user's clipboard.
- Local preflight and Electron IPC confirmed both TCP ports and UDP in the current
  VPN network. Synthetic tests cover retry/recovery after HTTP 502, cancellation,
  mapping cleanup, per-port results and an unrelated occupied TCP port.
- A separate installed Windows fixture completed real NSIS 0.1.0 → 0.1.1 replacement
  in 39 seconds, including helper readiness, visible installation status, new-app
  startup confirmation and preservation of nickname/settings/language/bookmark/
  protected password. The release/download source was synthetic. This fixture,
  mock feed and temporary demonstration tooling have been removed before release.
- Windows PowerShell process handoff is covered by an actual Electron-parent exit
  test. Helper tests cover success/failure, stale tokens and installer retention.
- Still outside this verification: real microphones, a second physical PC across
  separate internet networks, game/PTT/load acceptance, per-machine UAC, and an
  upgrade downloaded from two published GitHub Releases. Installers remain unsigned.
  / Реальные устройства, разные внешние сети, игры/PTT/нагрузка и UAC ещё требуют
  аппаратной приёмки. Установщики без подписи; источник релиза в upgrade-тесте — заглушка.

## LAN на Windows / Docker Desktop — 4 ноября 2026

- Создан и запущен отдельный compose.lan.yaml (pawtalk-lan): Go API, LiveKit, Caddy с обычным bridge networking и опубликованными TCP 443/7881, UDP 7882. API разделяет network namespace с Caddy и слушает только loopback; сохранена проверка доверенного X-Real-IP. Непосредственные API/SFU HTTP-порты не опубликованы.
- LiveKit сообщает явно заданный LAN IP 192.168.1.100 (проверены логи NAT1To1Ips). Основные production/dev конфигурации не изменены, их хеш пароля и ключи побайтово совпадают с LAN-копией.
- Caddyfile.lan и Compose валидны. HTTPS /healthz возвращает status=ok, /rtc отвечает 200, неправильный пароль отклоняется с 401 через TLS-прокси. Проверка сертификата не отключалась: публичный CA экспортирован из сохраняемого Docker volume и установлен в CurrentUser Root. Повторное создание контейнеров сохраняет доверие.
- Полный lan.cmd start успешно прошёл, включая проверку готовности API/SFU и экспорт публичного CA; lan.cmd status видит три работающих контейнера. Сформирован release/PawTalk-LAN-client.zip (только публичный сертификат, CMD и инструкция). 18 существующих JS-тестов PASS.
- lan.cmd firewall подготовлен для запуска администратором: локальный адрес сервера, RemoteAddress LocalSubnet, TCP 443/7881, UDP 7882. В этой сессии административных прав нет; правила не применялись. Уже существующие разрешающие TCP/UDP-правила Docker Desktop активны в Public-профиле текущего Ethernet.
- Запуск автоматических тестовых Electron-клиентов был отклонён автоматической проверкой разрешений с причиной "blocked by policy"; тесты передачи голоса через новый LAN-стек не выполнены. Не подтверждены второй физический ПК, прохождение UDP/ICE из LAN и задержка. В integration.cjs/main-smoke.cjs добавлен необязательный PAWTALK_TEST_SERVER для ручной проверки через HTTPS с OS trust, дефолт loopback сохранён.
- Сервер оставлен запущенным; dev LiveKit остановлен из-за общих портов. Временный Vite, запущенный только для проверки, остановлен. Сборка клиента/установщика не менялась, старый установщик подходит.

## Проверено 3 ноября 2026

## Выполнено в рабочем окружении

- TypeScript: строгая проверка типов; production Vite build.
- 18 JS-проверок: IP/HTTPS, VAD/PTT/mute, смена режима, автоматический порог, реальный скомпилированный AudioWorklet, настоящий RNNoise WASM, предыстория начала речи, очистка muted-сэмплов, миграция настроек, изоляция/удаление сохранённых паролей, взвешенный процент потерь и сбросы RTP-счётчиков.
- Go: тесты API/пароля/JWT/прав/лимитов/здоровья и `go vet`; Windows-бинарник API собран.
- Caddy 2.11.7: валидация production Caddyfile для IPv4 и IPv6 без заказа настоящих сертификатов.
- Electron 45.2.1: production renderer, навигация, синтетический микрофон, AudioWorklet, индикатор и остановка проверки. Скриншоты `release/qa/`.
- Windows C++ Node-API модуль: собран portable llvm-mingw, загружен и в Node.js, и в Electron. Регистрация/снятие keyboard/mouse hooks, изменение PTT-клавиши и сброс приглушения проходят smoke.
- Настоящий main/preload IPC: renderer без Node.js, native capabilities, настройка клавиш, запрос через Electron net к Go API.
- Два изолированных Chromium-клиента через настоящий LiveKit 1.13.11 и Go API на loopback: одинаковые никнеймы, двусторонний RTP с ненулевой энергией декодированного аудио, усиление 200%, deafen/restore, camera rejection, mute и отпущенная PTT без прироста речевой энергии, освобождение треков и исчезновение участника.
- Windows NSIS-установщик собран без цифровой подписи.
- Docker Desktop 4.97.0 / Linux Engine 29.9.2 / Compose 5.6.1: production/dev/LAN Compose-файлы прошли валидацию; multi-stage Go-образ собран с запуском Go-тестов внутри Linux build stage.
- Go API работает в non-root read-only контейнере; LiveKit 1.13.11 работает в read-only контейнере. Два Electron-клиента прошли аудио/токен/mute/PTT/deafen/200% проверки через этот стек, включая настоящий main/preload вход. Тестовые контейнеры и сеть удаляются автоматически. Отчёт: `release/qa/docker.txt`.
- Повторный вход участника в ту же комнату восстанавливает декодированный звук и создаёт новый playback graph без повторного использования привязанного HTMLMediaElement.
- Production Caddyfile прошёл валидацию внутри `caddy:2.11.7-alpine`; настоящие сертификаты не запрашивались.
- Запуск упакованного `release/win-unpacked/PawTalk.exe`: native resource вне ASAR загружается, интерфейс и настройки открываются, preload изолирован, HTTP-подключение отклоняется. Отчёт: `release/qa/packaged.txt`.
- Финальная RNNoise-сборка установщика: 131416417 байт. Расширенный packaged smoke подтвердил запуск синтетического микрофона с RNNoise по умолчанию и загрузку модели из ASAR; ошибок CSP или обращения к CDN нет.

## Найдено и исправлено

Обновлён интерфейс настроек по пользовательским референсам: серые сегменты до проверки, жёлтые сегменты при звуке после нажатия, сохранение проверки при изменениях, ползунок ручного порога поверх индикатора и компактный горизонтальный выбор шумоподавления. Скриншоты: `release/qa/audio-idle.png`, `audio-test.png`, `audio.png`.

Отдельная диагностика полностью удалена из приложения. До подключения нет участников/пустой комнаты/ссылки диагностики. После подключения hover/focus у антенны открывает только задержку и процент потерь; адрес не выводится. Расчёт потерь — взвешенная доля за последний интервал с обработкой восстановления поздних пакетов и замены потока. Попап закрывается Escape.

Проверено настоящее Windows safeStorage через асинхронные API Electron: пароль сохраняется зашифрованно по нормализованному серверу, открытого текста на диске нет, другой адрес/порт не получает чужой пароль. Реальный UI-тест вошёл в локальную комнату с выключенным синтетическим микрофоном, проверил попап, отсутствие адреса, автозаполнение пароля после перезагрузки renderer и удаление записи при снятии галочки. Отчёты: `release/qa/ui-session.txt`, `connection-popup.png`. Пользовательские настройки не менялись: тест использовал отдельный временный профиль.

Добавлен RNNoise 2025.1.5 с локальной моделью. Проверены три режима, отключение WebRTC NS при RNNoise, VAD на очищенном сигнале и 20-мс предыстория. Синтетическая тихая речь со щелчками проходит реальный SFU, нейросетевой VAD открывается. В офлайн-тесте корреляция очищенной речи с тихим чистым эталоном составила 0.977 при сдвиге 20 мс; средняя длительность inference — около 0.92 мс на 10-мс кадр в этом окружении (это не замер CPU игры). Unit-тест отдельно подтверждает подавление искусственных щелчков более 12 dB без gate. Отчёты: `release/qa/integration-rnnoise.txt`, `release/qa/rnnoise-quality.json`. Реальные клики мыши/клавиатуры и субъективное качество ещё требуют проверки. Устройство пользователя не записывалось. Подробнее — `docs/RNNOISE.md`.

После пользовательской проверки исправлен локальный запуск: в Docker Desktop был запущен production host-network стек при недоступном с Windows LiveKit. Локальный SFU переведён на `compose.dev.yaml` с пробросом портов; авторизация и реальная двусторонняя передача голоса проверены с пользовательским локальным API. Секреты и пароль не сохранялись в исходниках. Main-процесс предварительно проверяет доступность сигнального сервера и выдаёт понятное сообщение.

Прослушивание микрофона сохраняется при смене шумоподавления, эхоподавления, усиления, порога и устройства ввода. Живая шкала работает до включения прослушивания, показывает действующий порог и меняет подсветку при его пересечении. Эти сценарии добавлены в Electron smoke с синтетическим микрофоном; проверены уровень до прослушивания, оба состояния подсветки, ручная отметка и непрерывность при смене устройства/обработки.

В этой комбинации Electron/LiveKit использование SDK `webAudioMix: true` давало RTP-пакеты без слышимого декодированного аудио. Используется `webAudioMix: false` и собственный `MediaElementAudioSourceNode → GainNode → output` для каждого собеседника. Audio element остаётся unmuted; выход эксклюзивно направляется в WebAudio. Интеграционный тест проверяет декодированную энергию, поэтому наличие одних сетевых пакетов не считается успехом.

## Не подтверждено этим окружением

Docker-проверки выполнены на одном Windows-ПК с Linux containers и синтетическими микрофонами; тестовый стек использует bridge networking и loopback-порты. Production host networking на отдельном Linux-сервере, полный HTTPS-маршрут с настоящим доверенным IP-сертификатом, ACME-выдача/продление, чистая установка Windows, поведение реальных микрофонов, аппаратный PTT в играх, фактическое приглушение чужих аудиосессий, 30 соединений, потери сети и сравнение полной задержки/качества с Discord требуют испытаний из `ACCEPTANCE.md`. MSVC-сборка описана и включена в CI, локально использован llvm-mingw. CI пока не запускался на удалённом хосте.

## 2026-11-04 — встроенная комната в клиенте

Добавлены SelfHost (electron/selfhost.cjs), отдельный worker автопроброса UPnP с NAT-PMP fallback и Go selfhost-режим. Windows API и официальный LiveKit 1.13.11 входят в resources/server и установщик; пользователю не нужен Docker/Go/VPS. Подготовка scripts/prepare-server.mjs собирает Go, проверяет SHA-256 официального LiveKit zip, кладёт лицензии. Запускается в dev/package/build.ps1; Windows CI получил setup-go. VPS/Compose режим сохранён.

UI HostPanel: ник/пароль/порт, создание и автоматический локальный вход, приглашение pawtalk://IP:port/SHA256, выбор internet/LAN адреса, копирование, закрытие для всех. Приглашение включает проверку сертификата до отправки пароля; сертификат/ключи генерируются на каждую комнату. Нет глобального отключения TLS. Пароли не пишутся в localStorage, сохранение через прежний safeStorage отдельно по приглашению. Список успешных соединений сохраняется автоматически.

Порты по умолчанию TCP18443 API+TLS/WS proxy, TCP18444 RTC, UDP18445 RTC, TCP18446 LiveKit signaling только loopback. Ключ LiveKit временно в каталоге pawtalk-room-* в TEMP; пароль и TLS key только в памяти. Закрытие явно удаляет комнату через LiveKit API, затем останавливает дочерние процессы и удаляет пробросы. Сон закрывает комнату, трей сохраняет её работу. Аренды 1200 секунд, собственное продление каждые600сек (autoUpdate зависимости отключён из-за дефектов её таймеров). Windows NAT-PMP использует Get-NetRoute вместо отсутствующего WMIC. Hole punching/STUN-host-discovery/TURN не добавлены.

Проверено: 22 JS tests, TypeScript/Vite, Go tests+vet. scripts/selfhost-smoke.cjs: API/LiveKit startup, pinned TLS, password401, token/proxy, неверный pin, освобождение портов. На текущем роутере все три проброса успешны, после тестов UPnP таблица не содержит тестовых портов. scripts/selfhost-main-smoke.cjs: реальный UI/main/preload, автоматический вход хоста, второй клиент, ненулевая энергия декодированного голоса, неверный pin отклоняется, закрытие отключает гостя. Только на одном ПК с synthetic mic; внешний интернет/отдельный ПК не проверялись. scripts/packaged-smoke.mjs прошёл для нового win-unpacked с embedded API/LiveKit и TLS auth. NSIS release/PawTalk Setup 0.1.0.exe пересобран, 152195559 байт. qa/selfhost.txt и packaged.txt содержат результаты. Бывшие пользовательские Docker/VPS конфиги не менялись; тестовые процессы остановлены.
