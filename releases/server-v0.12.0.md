# PawTalk Server 0.12.0 — Encrypted event delivery, polls and presence

Preview for Windows x64 and Linux amd64/arm64; changes since Server 0.11.1.
Предварительная версия; изменения относительно Server 0.11.1.

[Download / Скачать](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.12.0/PawTalk.Server.0.12.0.windows-x64.zip)

## Русский

### Добавлено

- Необязательные chat-events-v1, server-events-v1 и message-events-v1: общий аутентифицированный поток состояния и зашифрованных пакетов сообщений. Зафиксированные сообщения, правки и удаления подготавливаются один раз в транзакции и рассылаются после commit без повторного HTTP-чтения каждым получателем. Очереди, кадры и подписки ограничены; пропуски и переполнение вызывают HTTP-сверку. Совместимые старые Client сохраняют события метаданных или опрос.
- Опросы с проверками вариантов, сроков, изменения/отмены голосов, анонимности и видимости промежуточных результатов. Общие часы Server завершают опросы и публикуют заранее зашифрованный системный ответ даже без автора онлайн; после остановки выполняется догоняющее завершение. Завершенные опросы/итоги защищены сервером от пользовательских изменений и удаления.
- Общий зашифрованный аватар сервера с правом изменения для администраторов и проверкой ревизий. Автоматическая активность устройств и статус связанного профиля; выбранные упоминания и муты обрабатываются Client без раскрытия текста Server.
- Отмена привязки устройств, удаление вложения при правке сообщения и дополнительные capabilities для независимого обновления компонентов.

### Исправлено

- Неуспешная транзакция не публикует сообщение. Повторы сохраняют исходный контекст автора/запроса/ключа; удаления по квоте тоже попадают в поток. Отзыв сессии закрывает подписку, доступ перепроверяется перед передачей.
- Зашифрованные аватары проверяются по лимитам изображения, а не приглашения. Статус привязки содержит данные только подтвержденных участников запроса.
- WebSocket ping/pong поддерживает живость сеанса; регулярное состояние, опросы и уведомления используют общий поток вместо отдельных частых опросов. Отдельная истекающая голосовая аренда и LiveKit/WebRTC сохраняют собственные проверки.

### Установка и обновление

Используйте Client 0.13.0 для новых функций. Manager 0.5.1 совместим и устанавливает Server отдельно. Сделайте backup, остановите Server и установите Windows ZIP через Manager либо обновите Linux-контейнер по подписанному server-manifest.json; затем перезапустите Server. Простой прерывает звонки. API/data schema остаются 2, таблицы добавляются без сброса существующего API 2 членства/истории. API 1 не поддерживается и не мигрируется автоматически. Новые функции определяются capabilities, а не номерами версий; старые API 2 Client продолжают работать в пределах прежних возможностей.

## English

### Added

- Optional chat-events-v1, server-events-v1 and message-events-v1 capabilities: a shared authenticated state/encrypted-message stream. Committed creates, edits and deletions are captured once in their writing transaction and published after commit without a separate HTTP history read per receiver. Frames, queues and subscriptions are bounded; gaps/overflow trigger HTTP recovery. Compatible older Clients retain metadata invalidation or polling.
- Poll validation for choices, expiry, changing/withdrawing votes, anonymity and interim-result visibility. A shared Server clock closes polls and publishes a pre-encrypted System reply even with the author offline; restart catches overdue polls up. Completed polls/results are protected against user edits and deletion by Server.
- A shared encrypted server avatar with administrator/revision checks. Per-device activity and linked-profile presence; Client handles selected mentions and mutes without revealing message text to Server.
- Device-link cancellation, attachment removal while editing and additional capabilities for independent component upgrades.

### Fixed

- Failed transactions publish no message. Retries preserve immutable author/request/key context; quota deletions also enter the stream. Session revocation closes subscriptions and access is rechecked before delivery.
- Encrypted avatars use image limits instead of invitation limits. Link status discloses participant data only to the proven sides of that request.
- WebSocket ping/pong maintains session liveness; state, polls and notifications share the stream instead of independent frequent polling. The separate expiring voice lease and LiveKit/WebRTC retain their own checks.

### Install or update

Use Client 0.13.0 for the new features. Manager 0.5.1 remains compatible and installs Server separately. Back up, stop Server and import the Windows ZIP through Manager or update the Linux container using signed server-manifest.json; restart Server afterward. Downtime interrupts calls. API/data schema remain 2; additive tables preserve existing API 2 membership/history. API 1 is unsupported and has no automatic migration. Capabilities, rather than release numbers, determine feature availability; older API 2 Clients retain their existing functionality.

## Ограничения / Limitations

Предварительный выпуск. Server хранит непрозрачные сообщения и пакеты ключей, но видит метаданные и голоса опросов. Анонимность не скрывает голоса от оператора. Нет канальных ролей, автоматической ротации ключей или forward secrecy. Отзыв API-сессии не уничтожает уже полученные данные; LiveKit-токен может действовать до истечения срока. Ограничения хранилища/удаление истории могут удалять опросы и итоги. Локальные TCP-замеры 100/500/1000 получателей не включают TLS, расшифровку и голос и не являются гарантией производственной вместимости. Redis не требуется и не добавлен; сохранены HTTP-восстановление и обратная совместимость API 2.

Preview. Server stores opaque messages/key packages but sees metadata and poll ballots; anonymity does not hide votes from its operator. No channel roles, automatic key rotation or forward secrecy. API revocation cannot erase retained data; a LiveKit token can remain usable until expiry. Storage quotas/history deletion may remove polls/results. Local TCP tests with 100/500/1000 receivers exclude TLS, client decryption and voice and are not production-capacity guarantees. Redis is not required or added; HTTP recovery and API 2 compatibility remain.

## Файлы и исходники / Assets and source

PawTalk.Server.0.12.0.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.12.0

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.12.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.12.0/LICENSE)

Independent component Ed25519 update manifests verify downloads; third-party notices remain included.
Подпись Ed25519 манифеста компонента проверяет загрузки; уведомления о сторонних лицензиях включены.
