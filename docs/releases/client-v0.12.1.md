# PawTalk Client 0.12.1 — Servers, channels and linked devices

Preview for Windows x64; changes since Client 0.11.0.
Предварительная версия Windows x64; изменения относительно Client 0.11.0.

[Windows installer / Установщик](https://github.com/IlyaRusskikh/PawTalk/releases/download/client-v0.12.1/PawTalk.Setup.0.12.1.exe)

Тег client-v0.12.0 не прошёл проверку до публикации и сохранён без изменений; этот выпуск включает полное обновление относительно последней опубликованной версии.
The client-v0.12.0 tag failed verification before publication and remains unchanged; this release includes the complete update since the last published version.

## Русский

### Добавлено

- Несколько голосовых каналов и текстовых чатов на сервере. Можно читать и писать без подключения к голосу; выбор чата сохраняет текущий звонок. Администраторы создают, переименовывают и удаляют каналы и задают общее имя сервера. «Общий» и «Основной» защищены от удаления.
- Постоянное членство, список участников со статусом и пином «Вы», миниатюры голосовых участников, предпросмотр сервера и перетаскивание серверов/каналов с предварительным смещением. Переполнение миниатюр отображается как +N.
- Одноразовые приглашения на 24 часа и многоразовые на час; приглашать могут администраторы и модераторы. Связывание устройств подтверждается на двух сторонах отдельно для каждого сервера; доступны передача управления, отвязка и отзыв потерянного устройства. Связанные устройства используют профиль и действующие права группы, включая редактирование сообщений; голос доступен одному устройству группы.
- Выход с сервера, включая отложенную доставку команды недоступному серверу; выход из собственного клиентского селфхоста останавливает его с предупреждением. Кик и бан показывают отдельные уведомления с названием сервера и доступным сроком бана.
- Мастер первого запуска, отключение уведомлений выбранного сервера на срок или бессрочно, уведомления Windows с автором и читаемым содержимым сообщения. Системный звук уведомления отключён; служебная разметка удаляется, спойлеры скрыты.

### Исправлено

- Штатный выход из собственного селфхоста больше не показывает ложное уведомление о кике при запоздавшем запросе членства. Настоящие кики и баны продолжают отображаться.

- Цитаты отражают актуальное содержимое исходного сообщения и переходят к нему по нажатию; сохранены черновики, фокус ввода, якоря чтения и прокрутка. Открытие непрочитанного чата ведёт к разделителю новых сообщений; удаление последнего сообщения не создаёт ложный переход к новым.
- Исправлены обрезка пинов/прокрутки, отступы настроек, оформление кнопок, обратная связь копирования и повторное завершение передачи управления. Открытый активный чат не уведомляет о сразу видимых сообщениях даже при медленной синхронизации.
- Диагностика хостинга сравнивает WAN IPv4 маршрутизатора с внешним IPv4 и поясняет возможное несовпадение.

### Изменено

- E2EE обязательно для текста, голоса и вложений. Генерация секрета скрыта в первоначальной настройке, приглашения доставляют зашифрованный пакет ключа.
- Кнопка отключения звука отключает также микрофон; включение любого из них после общего отключения включает оба. Отдельное отключение микрофона оставляет звук включённым.

### Установка и обновление

Установите Client 0.12.1. Для постоянного сервера требуются Server 0.11.1 и Manager 0.5.1; встроенное ядро селфхоста обновляется с клиентом. API 1 несовместим и отвергается: автоматической миграции старой серверной истории/членства нет. Создайте новый API 2 сервер и новые приглашения; сохраните старую установку/backup отдельно для отката. Перезапуск селфхоста отключает его участников. Ключи устройств и секреты сохраняются локально в защищённом хранилище ОС.

## English

### Added

- Multiple voice channels and text chats per server. Chat works without joining voice, and switching chats preserves the call. Administrators manage channels and the shared server name; the default General text and Main voice channels cannot be deleted.
- Persistent membership, a roster with presence and a You badge, compact voice participants, server hover previews and live drag-reorder previews. Overflow avatars become +N.
- Single-use 24-hour and reusable one-hour invitations, issued by administrators/moderators. Server-local device linking requires confirmation on both sides; control transfer, unlink and lost-device revocation are available. Linked devices share the group's profile/current rights, including message editing; only one device per group may join voice.
- Server departure, durable offline departure requests and confirmed shutdown when leaving your own Client-hosted server. Separate kick/ban notices show the server and available ban expiry.
- First-run setup, timed/indefinite server notification muting and Windows notifications with author and readable content. OS notification sound is disabled; formatting markers are removed and spoilers concealed.

### Fixed

- Leaving your own selfhost no longer shows a false kick notice when a membership request completes late. Genuine kick and ban notices remain active.

- Replies resolve current originals and navigate to them, while preserving drafts, input focus, reading anchors and scrolling. Unread chats open at the unread divider; deleting the latest message does not create a phantom jump action.
- Corrected clipped badges/scrollbars, settings spacing, button styling, copy feedback and repeated control-transfer completion. Immediately visible messages in the active chat stay silent even during slow synchronization.
- Hosting diagnostics compare router WAN IPv4 with external IPv4 and explain possible mismatches.

### Changed

- E2EE is mandatory for text, voice and attachments. Initial setup creates the secret automatically; invitations carry an encrypted key package.
- Deafen also mutes the microphone; enabling either control after deafen restores both. Microphone-only mute leaves incoming sound enabled.

### Install or update

Install Client 0.12.1. Permanent hosting requires Server 0.11.1 and Manager 0.5.1; Client includes the updated selfhost core. API 1 is explicitly incompatible and has no automatic server history/membership migration. Create a fresh API 2 server and new invitations, retaining the old installation/backup separately for rollback. Restarting selfhost disconnects its participants. Device keys and secrets remain in OS-protected local storage.

## Ограничения и файлы / Limitations and assets

Preview: доступ к каналам одинаков для всех; настраиваемых ролей/закрытых каналов и ротации ключа после кика/бана нет. Уже полученные ключи/данные не отзываются. Реальные устройства, игры/PTT, внешние сети и нагрузка требуют отдельной приёмки. EXE не имеет Authenticode-подписи.

Preview: channels share the same access; custom roles/private channels and post-kick/ban key rotation are not implemented. Previously obtained keys/data cannot be revoked. Physical devices, games/PTT, external networks and load need separate acceptance. EXE has no Authenticode signature.

- `PawTalk.Setup.0.12.1.exe`, `SHA256SUMS.txt`, `update-manifest.json`, `PawTalk.Licenses.0.12.1.zip`.
- Verify / Проверка: `Get-FileHash .\PawTalk.Setup.0.12.1.exe -Algorithm SHA256`; compare SHA256SUMS and the component's Ed25519 update manifest. Ed25519 does not replace Authenticode.
- [Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/client-v0.12.1) · [CHANGELOG](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.12.1/CHANGELOG.md) · [Guide / Руководство](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.12.1/docs/GUIDE.ru.md) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/client-v0.12.1/LICENSE). License archive retains third-party notices.
