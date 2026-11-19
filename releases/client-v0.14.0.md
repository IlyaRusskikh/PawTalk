# PawTalk Client 0.14.0 — Media galleries, voice messages and interactive checklists

Preview for Windows x64; changes since Client 0.13.0.
Предварительная версия; изменения относительно Client 0.13.0.

[Download / Скачать](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.14.0/PawTalk.Setup.0.14.0.exe)

## Русский

### Добавлено

- Голосовые сообщения через меню «+»: запись в строке ввода, живая звуковая дорожка, остановка и переслушивание до отправки. Плеер поддерживает паузу, перемотку, скорости 0.75×/1×/1.5×/2× и громкость 0–200%.
- Вложения до 50 МиБ для видео MP4/WebM, GIF, аудио и документов; до десяти файлов в сообщении. Документы сохраняют исходные байты, фото PNG/JPEG/WebP ограничены 2 МиБ. Карточки черновика позволяют просмотреть, переименовать и удалить файл; перетаскивание на окно показывает чат назначения.
- Сетка вложений в два столбца, сохранённый отправителем кадр видео и общий просмотрщик фото/видео с автором, датой, скачиванием, переключением, масштабированием фото и настоящим полным экраном. Пробел управляет видео, стрелки перематывают на пять секунд; панели скрываются при бездействии.
- «Интерактивный список»: редактируемое название и пункты, выбор права отметки перед отправкой («все» или «автор»), зачёркивание выполненного и синхронизация отметок по WebSocket.
- Markdown-меню с иконками и подменю по наведению: заголовки, списки, линия и блок кода. Таблицы поддерживаются при ручном вводе. Предпросмотр заменяет поле ввода без изменения его высоты.
- Распознавание GIF-ссылок Tenor/Giphy/Klipy, включая ссылки без расширения и первую анимацию страниц поиска. Резервная загрузка помогает при сбое прямого транспорта Chromium.
- Новый стартовый экран для присоединения и создания сервера.

### Исправлено

- Нумерованные списки, отступы маркеров, предпросмотр, кастомный скролл и время сбоку последовательных сообщений; полная дата доступна при наведении на время.
- Громкость и локальный мут собеседника сохраняются после полного перезапуска Client. Уведомления Windows показывают аватар отправителя. Идентификатор процесса/окна согласован с ярлыками установщика для панели задач и автозапуска.
- Загрузчик сначала замеряет GitHub, затем настроенные серверы, продолжает самый быстрый поток без повторного скачивания начала и закрывает остальные. Проверки подписанного размера и SHA-256 сохранены; нарушение целостности останавливает обновление.

### Установка и обновление

Установите Windows x64 EXE либо воспользуйтесь обновлением Client. Для галерей, общих кадров видео, 50 МиБ и интерактивных списков обновите постоянный Server до 0.13.0; проверка возможностей выполняется по capabilities. Старые API 2 Server сохраняют прежние ограничения. Manager 0.5.1 совместим и обновляется независимо. После обновления полностью перезапустите Client. Если старое закрепление даёт вторую иконку, один раз открепите его и закрепите работающий обновлённый Client заново.

## English

### Added

- Voice messages from the + menu: inline recording, live waveform, stop and preview before sending. Playback supports pause, seeking, 0.75×/1×/1.5×/2× speed and 0–200% listener volume.
- Up to 50 MiB per MP4/WebM video, GIF, audio or document, and ten attachments per message. Documents preserve original bytes; PNG/JPEG/WebP photos retain a 2 MiB limit. Draft cards provide preview, rename and removal; dragging onto the window shows the destination chat.
- Two-column attachment grids, sender-generated saved video posters and a shared photo/video viewer with sender, date, download, navigation, photo zoom and native fullscreen. Space toggles video playback, arrows seek five seconds, and idle playback hides controls.
- Interactive checklists with editable titles/items, a sender-selected everyone/author checking policy, struck-through completed items and WebSocket synchronization.
- Hover-operated Markdown icon menus for headings, lists, rules and code blocks. Typed tables remain supported. Read-only preview replaces input without changing its height.
- Tenor/Giphy/Klipy GIF-link resolution, including extensionless links and the first animation on search pages. A bounded fallback handles direct Chromium transport failures.
- A refreshed home screen for joining and creating servers.

### Fixed

- Numbered lists, marker spacing, preview alignment, custom scrolling and compact hover timestamps for consecutive messages; hovering the time exposes its full date.
- Other participants’ local gain/mute preferences survive a full Client restart. Windows alerts display sender avatars. Process/window identity matches installed shortcuts for taskbar grouping and startup.
- Installer downloads sample GitHub and configured servers, retain the fastest measured stream without refetching its prefix, and cancel the others. Signed size and SHA-256 checks remain mandatory; integrity violations stop the update.

### Install or update

Install the Windows x64 EXE or use Client updates. Upgrade a permanent Server to 0.13.0 for galleries, shared video posters, 50 MiB attachments and interactive checklists; capabilities determine support. Older API 2 Servers retain their limits. Manager 0.5.1 remains compatible and updates independently. Fully restart Client after updating. If an older taskbar pin still creates another icon, unpin it once and pin the running updated Client again.

## Ограничения / Limitations

Предварительный выпуск. Видеовложения не являются видеозвонками или демонстрацией экрана; поддержка кодеков зависит от Electron. Распознавание внешних GIF зависит от доступности провайдера. Замеры зеркал оценивают текущую скорость, а не гарантируют постоянную пропускную способность. Старые Client не отображают галереи. Перезагрузка Windows с существующим закреплением, физические микрофоны, игры/PTT, внешние сети и длительная нагрузка требуют отдельной приёмки. EXE не имеет Authenticode-подписи.

Preview. Video attachments do not provide video calls or screen sharing; codec support depends on Electron. External GIF resolution depends on provider availability. Mirror probes estimate current throughput rather than guaranteeing sustained bandwidth. Older Clients cannot display galleries. Reboot behavior with an existing taskbar pin, physical microphones, games/PTT, external networks and sustained load need separate acceptance. The EXE has no Authenticode signature.

## Файлы и исходники / Assets and source

PawTalk.Setup.0.14.0.exe · SHA256SUMS.txt · update-manifest.json · PawTalk.Licenses.0.14.0.zip

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.14.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.14.0/LICENSE)

Independent component Ed25519 manifests verify downloads; third-party notices remain included.
Подписи Ed25519 манифестов компонентов проверяют загрузки; сторонние лицензии включены.
