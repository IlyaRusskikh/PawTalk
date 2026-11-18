# PawTalk Client 0.13.0 — Live chat, mentions and polls

Preview for Windows x64; changes since Client 0.12.1.
Предварительная версия; изменения относительно Client 0.12.1.

[Download / Скачать](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.13.0/PawTalk.Setup.0.13.0.exe)

## Русский

### Добавлено

- Общий WebSocket-поток сервера доставляет зашифрованные сообщения, правки и удаления прямо в Client. Состояние, непрочитанное и уведомления используют общий поток; HTTP остается для команд, начальной истории, прокрутки и восстановления пропусков.
- Упоминания через @ с аватарами в подсказках и перетаскиванием участника в поле сообщения. Выбранное упоминание связано с профилем, выделяется цветом темы и обходит мут сервера/чата; после офлайна остается заметный пин. Ручной совпадающий текст не заменяет выбор участника.
- Опросы: 2–10 ответов, один или несколько вариантов, анонимность и промежуточные результаты. Сроки: 1, 4, 8, 24 часа, 3 дня, 1 или 2 недели. Голос можно менять и отменять; автор завершает опрос досрочно. Неанонимные результаты показывают аватары с раскрываемым переполнением. Итог приходит отдельным системным ответом, даже без автора онлайн; завершенные опросы и итоги защищены от пользовательского удаления.
- Мут отдельных текстовых чатов на срок или до включения вручную, заметные пины непрочитанного и серые счетчики заглушенных чатов/серверов. Уведомления Windows объединяются по чату, заменяют прежнее окно и отменяются после прочтения на этом устройстве, включая центр уведомлений.
- Автоматический статус «Отошел» через пять минут отсутствия системной активности, в том числе во время звонка. Статус дублируется в панели пользователя; ручного переключателя нет. Связанный профиль остается онлайн, пока активно хотя бы одно устройство.
- Общий аватар сервера, доступный для изменения администраторам. Редактор показывает квадратную обрезку и круглую безопасную область.

### Исправлено

- Микрофон, отключение звука, выбор устройств и выход из голоса продублированы в центре блока звонка; нижняя панель сохранена. Исправлены отступы участников и геометрия кнопок.
- Подтверждение связи устройств автоматически открывается поверх текущей работы и восстанавливает фокус окна. Закрытие отклоняет запрос; посторонние открытые формы сохраняются. Окно подтверждения не показывает поле ввода строки привязки.
- При редактировании изображения удаляются корзиной в углу превью по наведению. Сохранение без текста и вложения удаляет сообщение целиком. Исправлены сохранение серверного аватара, размер инициалов и обрезка модалки опроса.
- Исходящее сообщение сразу вылетает из ввода серым и получает обычный цвет после подтверждения сервера, без повторной анимации и сдвига старых строк. Ошибка сохраняет черновик; повтор использует прежний идентификатор запроса.
- История догружается автоматически, без кнопок «предыдущие/следующие». Настройка 25–500 сообщений (по умолчанию 100) задает порцию, а не лимит кеша. Загруженные блоки сохраняются в RAM до выхода из чата или нехватки памяти; возврат к ним и переходы по цитатам используют кеш. Стрелка вниз справа показывает число новых сообщений. Сохранены якоря чтения и ленивые изображения.

### Разработка

- Make-команды запускают и останавливают изолированные review Client, Manager и Server. Review Server хранит собственные данные и не требует добавления версии в установленный Manager. Скриншоты лендинга обновлены для обоих языков.

### Установка и обновление

Установите Client 0.13.0. Для новых серверных функций сначала обновите постоянный Server до 0.12.0 через совместимый Manager 0.5.1; обновлять Manager только ради этого Server не требуется. Client содержит то же ядро Server 0.12.0 для временного хостинга. Client продолжает работать с прежними Server API 2, скрывая неподдерживаемые возможности или сохраняя HTTP-обновление. Обновление Client не заменяет отдельный Server. Перед заменой Server сделайте backup; перезапуск прерывает звонки. API/data schema остаются 2; API 1 несовместим и не имеет автоматической миграции истории/членства.

## English

### Added

- A shared server-wide WebSocket delivers encrypted messages, edits and deletions directly to Client. State, unread counts and notifications share this stream; HTTP remains for commands, initial history, scrolling and gap recovery.
- Identity-bound @mentions with avatar suggestions and roster-to-composer drag and drop. Selected mentions use the theme accent, bypass server/channel mutes and retain a visible unread pin after an offline period. Matching plain text does not replace selecting a member.
- Polls with 2–10 options, single/multiple choices, anonymous voting and configurable interim results. Durations: 1, 4, 8 or 24 hours, 3 days, 1 or 2 weeks. Change or withdraw votes; authors can end polls early. Non-anonymous results show voter avatars with expandable overflow. A separate System reply publishes the result even with the author offline; completed polls and results cannot be deleted by users.
- Per-text-channel notification mutes with timed or manual expiry, clearer unread pins and gray muted server/channel counters. Windows alerts are grouped by chat, replace their predecessor and are cancelled after reading on this device, including their Action Center entry.
- Automatic Away presence after five minutes of system inactivity, including during calls, repeated in the user panel without a manual toggle. A linked profile stays online while any of its devices remains active.
- A shared server avatar editable by administrators, with square cropping and a circular safe-area guide.

### Fixed

- Microphone, deafen, device selection and voice disconnect are duplicated in the center of the call panel; lower user controls remain. Participant spacing and button geometry are corrected.
- Incoming device-link confirmation reopens above current work and restores window focus. Closing it rejects the request while preserving unrelated open forms. Confirmation does not display the link-input field.
- Remove an edited image using the hover trash control on its preview; saving without text or an image deletes the message. Server-avatar saving, avatar initials and poll-dialog clipping are corrected.
- Outgoing messages fly from the composer immediately in gray and regain normal color after server acknowledgment, without a second animation or moving older rows. Failures preserve the draft; retries reuse the request ID.
- History loads automatically without previous/next buttons. The 25–500-message preference (default 100) controls page size rather than cache capacity. Loaded blocks stay in RAM until leaving the chat or memory pressure; revisiting them and following replies reuse the cache. The lower-right down arrow shows new-message counts. Reading anchors and lazy image loading are preserved.

### Development

- Make commands start/stop isolated review Client, Manager and Server instances. Review Server keeps separate data without importing a version into installed Manager. Landing screenshots are refreshed in both languages.

### Install or update

Install Client 0.13.0. For new server-side features, upgrade permanent Server to 0.12.0 first using compatible Manager 0.5.1; this Server does not require a Manager upgrade. Client includes the same Server 0.12.0 core for temporary hosting. Older API 2 Servers remain usable with unsupported features hidden or HTTP fallback. Updating Client does not replace a separately installed Server. Back up Server before replacing it; restarting interrupts calls. API/data schema remain 2; API 1 is incompatible and has no automatic history/membership migration.

## Ограничения / Limitations

Предварительный выпуск. Уведомления зависят от настроек звука, deafen и ограничений ОС; прочтение локально для устройства. Анонимные голоса скрыты от участников, но не от оператора Server. Нет закрытых каналов по ролям, автоматической ротации ключей или forward secrecy; ранее полученные ключи/данные нельзя отозвать. Кеш/DOM истории может расти при доступной памяти. Физические микрофоны, игры/PTT, внешние сети и длительная нагрузка требуют отдельной приемки. EXE не имеет Authenticode-подписи; Ed25519-манифест обновления не заменяет подпись издателя Windows.

Preview. Alerts remain subject to sound settings, deafen and OS restrictions; read state is device-local. Anonymous votes are hidden from members, not the Server operator. No role-restricted channels, automatic key rotation or forward secrecy; previously retained keys/data cannot be revoked. History cache/DOM can grow while memory is available. Physical microphones, games/PTT, external networks and sustained load require separate acceptance. The EXE has no Authenticode signature; its Ed25519 update manifest does not replace a Windows publisher signature.

## Файлы и исходники / Assets and source

PawTalk.Setup.0.13.0.exe · SHA256SUMS.txt · update-manifest.json · PawTalk.Licenses.0.13.0.zip

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.13.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.13.0/LICENSE)

Independent component Ed25519 update manifests verify downloads; third-party notices remain included.
Подпись Ed25519 манифеста компонента проверяет загрузки; уведомления о сторонних лицензиях включены.
