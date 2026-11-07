# Changelog / История изменений

## Unreleased / Не выпущено

- Remove the chat information tooltip and header so the feed fade starts directly below the divider. / Удалены подсказка и шапка чата: fade ленты начинается сразу под разделителем.

- Add message text copying and a hidden room scrollbar with a live +N overflow count. Replace VPS age/count retention with `VOICECORD_CHAT_MAX_MB` (128 MiB default, 0 unlimited), including images/profiles/indexes and disk reclamation. / Добавлены копирование текста и скрытый скроллбар закладок с индикатором +N. Хранение истории VPS по возрасту и количеству заменено на `VOICECORD_CHAT_MAX_MB` (128 МиБ по умолчанию, 0 без лимита), включая картинки, профили, индексы и освобождение места на диске.
- Preserve visible text coordinates during backward/forward paging, retain grouping context at window edges, and trim offscreen messages before visible ones. / При подгрузке в обе стороны сохраняются координаты видимого текста и контекст группировки на границе окна; сначала удаляются сообщения вне экрана.
- Fix small-window history bouncing during viewport restoration, scope resets to the current settings tab, dismiss idle toasts after five seconds with interaction pauses, and use the current asynchronous Electron image clipboard API. / Исправлены скачки истории при восстановлении позиции в небольшом окне чата; сброс ограничен текущей вкладкой, toast исчезает через пять секунд бездействия с паузой при взаимодействии, копирование изображений переведено на актуальный асинхронный API Electron.
- Group reachable/offline rooms while preserving saved order, restore send animations, align the chat field, compact the chat heading, use floating notifications, and keep call controls in the room. / Доступные и недоступные комнаты разделены с сохранением порядка; возвращена анимация отправки, выровнено поле чата, уменьшена шапка чата, уведомления показываются поверх страницы, управление звонком оставлено в комнате.
- Add fitted image viewing with zoom/pan and save/copy actions, simplify server key instructions, and make interface colors and corners follow the editable palette in both light and dark themes. / Добавлены просмотр картинок с масштабом и перетаскиванием, сохранение и копирование; упрощены инструкции к ключу сервера, все цвета и скругления следуют настройкам оформления в светлой и тёмной темах.
- Simplified the chat composer to a full-width field with an attachment menu, retaining Enter to send, and added the current version to update settings. / Поле чата занимает всю ширину и содержит меню вложений; отправка по Enter сохранена. В настройках обновлений показана текущая версия.
- Redesigned the home screen and Settings with a navigation sidebar, a detailed palette and a light preset, compact connection failures with diagnostic popovers, and update preferences/manual checks. / Обновлены стартовый экран и настройки: боковая навигация, подробная палитра и светлый пресет, компактные ошибки подключения с деталями в попапе, переключатель и ручная проверка обновлений.
- Added static image attachments up to 2 MiB, encrypted in E2EE rooms, and message replies from the context/hover menu. Images load near the viewport and release their object URLs on exit. / Добавлены статические изображения до 2 МиБ, шифруемые в E2EE, и ответы из контекстного меню/меню при наведении. Картинки загружаются рядом с видимой областью и освобождаются при выходе из неё.
- Added bounded server pagination and a configurable 25–500-message client window (default 100), including backward/forward loads and jumps to replied-to messages. Updated non-E2EE servers also retain chat; the server can read that content. / Добавлены страницы истории на сервере и окно клиента на 25–500 сообщений (100 по умолчанию), прокрутка в обе стороны и переход к исходнику ответа. Обновлённый сервер без E2EE тоже хранит чат и может читать его содержимое.
- Separated participant/unread badges with icons, added a three-person room preview with +N overflow and an explicit offline indicator. Detailed previews require saved room access. / Разделены счётчики участников и непрочитанных с иконками, добавлены попап с тремя участниками и +N и индикатор недоступного сервера. Подробности доступны с сохранённым доступом к комнате.
- Prepared an opt-in VPS updater and a pinned single-replica Swarm stack with healthchecks/rollback. Not deployed; real Linux rollout testing remains outstanding. / Подготовлены автообновление VPS по флагу и Swarm-стек с одной закреплённой репликой, healthcheck и откатом. На сервер не применялись; реальный rollout на Linux ещё не проверен.

## 0.4.1 — 2026-11-07 — Rejoin and chat fixes / Повторный вход и чат

- Resynchronize avatars and nicknames once a connection is ready and request existing participants' profiles after joining or reconnecting. / Аватары и никнеймы повторно отправляются после готовности соединения; при входе и восстановлении связи клиент запрашивает профили остальных участников.
- Notify peers over LiveKit's reliable data channel after saving a chat message or profile, triggering an immediate history refresh. Keep the 2.5-second poll for recovery and older clients; queue notifications received during an active fetch. All participants should update for immediate delivery. / После сохранения сообщения или профиля участники получают уведомление по надёжному каналу LiveKit и сразу обновляют историю. Опрос раз в 2,5 секунды остаётся для восстановления и старых клиентов; уведомления во время запроса не теряются. Для быстрой доставки нужно обновить клиенты всех участников.
- Group consecutive messages from the same identity within five minutes, separating dates and the unread boundary. Highlight individual rows on hover and show continuation timestamps on hover or keyboard focus. / Последовательные сообщения одного участника за пять минут объединяются с учётом даты и границы непрочитанного. При наведении подсвечивается строка, у продолжений появляется время, доступное также с клавиатуры.
- Separate Settings errors from connection notices so a failed join does not appear in the profile dialog. / Ошибки настроек отделены от уведомлений подключения: неудачный вход больше не отображается в окне профиля.

## 0.4.0 — 2026-11-07 — Room chat and profiles / Чат комнаты и профили

- Added text chat, typing indicators and a limit of three messages per second per participant. / Добавлены текстовый чат, индикатор набора и лимит в три сообщения в секунду на участника.
- Standalone servers with E2EE keep up to 500 encrypted messages for seven days in SQLite. Restarting with the same key fingerprint preserves the feed. Built-in E2EE rooms keep history in memory until the host stops, and rooms without E2EE show live messages. / Отдельный сервер с E2EE хранит до 500 зашифрованных сообщений в SQLite до семи дней. Перезапуск с прежним отпечатком ключа сохраняет ленту. Встроенные комнаты с E2EE хранят историю в памяти до остановки, комнаты без E2EE показывают сообщения во время подключения.
- Added device profiles with current names and avatars in retained chat. The avatar editor previews a circular crop and supports zoom and repositioning. / Добавлены профили устройств с актуальными именами и аватарами в истории чата. Редактор аватара показывает круглый предпросмотр и поддерживает масштабирование и сдвиг.
- Redesigned the room with a resizable chat, adaptive participant avatars, call controls, and per-participant latency and packet loss. Chat restores the scroll position on rejoin and jumps to unread messages. / Обновлена комната с изменяемой высотой чата, адаптивными аватарами, кнопками звонка и пингом и потерями пакетов для каждого участника. При повторном входе чат восстанавливает прокрутку и позволяет перейти к непрочитанному.
- Fixed focus after opening a hosted room and updated the UI smoke test to check call controls in a connected room. / Исправлен фокус после входа в свою комнату. Проверка кнопок звонка перенесена в тест с активным подключением.

## 0.3.0 — 2026-11-06 — Bookmarks and quick audio / Закладки и быстрый выбор звука

- Added persistent local server names editable from the bookmark context menu. / Добавлено переименование через ПКМ по закладке; имя сохраняется и отображается в комнате и закладке.
- Added a filled star toggle to add/remove bookmarks and drag-and-drop to persist their order. / Звёздочка добавляет и удаляет закладки, заполняется для избранного; порядок закладок меняется перетаскиванием и сохраняется.
- Added optional Windows sign-in startup, including minimized-to-tray startup. / Добавлен автозапуск при входе в Windows с возможностью запуска свёрнутым в трее.
- Added participant-count badges on bookmarks and a cached aggregate server presence endpoint. Other rooms refresh every 10 seconds while the window is visible and focused; older or unavailable servers show `?`. / Добавлены счётчики участников на закладках и серверный запрос количества участников; другие комнаты обновляются каждые 10 секунд, пока окно видно и активно, старые или недоступные серверы показывают `?`.
- Added microphone/headphone arrow menus for device selection and volume without opening Settings. / Стрелки рядом с микрофоном и наушниками открывают выбор устройства и громкости без перехода в настройки.
- Clicking the active server returns to its room without reconnecting. The home lobby remains accessible during a voice session. / Нажатие на активный сервер возвращает в комнату без переподключения; стартовое лобби доступно во время голосового соединения.
- Fixed sharing the currently connected remote room while a separate built-in host is running. / Исправлено приглашение в текущую удалённую комнату при одновременно работающем селфхосте.
- Validated client build, 75 client tests, Go tests/vet and Electron flows with synthetic audio in Russian and English. Windows sign-in startup and real-device/external-network acceptance remain to be checked. / Проверены сборка, 75 тестов клиента, Go test/vet и сценарии Electron с синтетическим аудио на русском и английском; автозапуск при входе в Windows, реальные аудиоустройства и внешняя сеть требуют проверки.

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
