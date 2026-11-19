# PawTalk Server 0.13.0 — Encrypted media galleries and live checklists

Preview for Windows x64 and Linux amd64/arm64; changes since Server 0.12.0.
Предварительная версия; изменения относительно Server 0.12.0.

[Download / Скачать](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.13.0/PawTalk.Server.0.13.0.windows-x64.zip)

## Русский

### Добавлено

- media-files-v1: до 50 МиБ открытых байтов зашифрованного вложения. При запуске ограничение прежней таблицы расширяется транзакционно, с сохранением данных, индексов и проверок владельца.
- media-gallery-v1: до двадцати уникальных ID вложений на сообщение для десяти файлов и их кадров превью. Привязка атомарна, повтор сравнивает весь набор ID независимо от порядка; дубли отклоняются. До двадцати незавершённых загрузок на устройство хранятся тридцать минут, с прежними квотами хранилища.
- checklists-v1: непрозрачные ID пунктов и политика «все/автор», проверка прав и идемпотентные мутации. Названия и текст пунктов остаются зашифрованными. Редактирование сохраняет отметки существующих ID и удаляет исчезнувшие.
- checklist-events-v1: отметки включаются в подтверждённый поток сообщений и увеличивают ревизию канала; Client отбрасывает старые снимки и восстанавливает пропуски через HTTP.

### Установка и обновление

Сделайте backup и остановите постоянный Server. Импортируйте Windows x64 ZIP через Manager либо обновите Linux-контейнер по подписанному server-manifest.json; перезапустите Server. Простой прерывает звонки. Используйте Client 0.14.0 для новых функций; Manager 0.5.1 совместим. API/data остаются 2, существующее API 2 членство и история сохраняются. Старые Client читают прежние одиночные вложения, но требуют обновления для галерей. API 1 не поддерживается и автоматически не мигрируется.

## English

### Added

- media-files-v1 permits up to 50 MiB of encrypted-attachment plaintext. Startup transactionally expands the previous table limit while preserving data, indexes and ownership checks.
- media-gallery-v1 binds up to twenty unique attachment IDs per message for ten files and their posters. Binding is atomic; replay compares the complete ID set independently of order and rejects duplicates. Up to twenty pending uploads per device expire after thirty minutes, subject to existing storage quotas.
- checklists-v1 stores opaque item IDs and an everyone/author checking policy, validates permissions and makes mutations idempotent. Titles and item text remain encrypted. Edits retain checks for surviving IDs and discard removed IDs.
- checklist-events-v1 includes checks in committed message events and advances channel revisions; Client rejects stale snapshots and recovers gaps over HTTP.

### Install or update

Back up and stop the permanent Server. Import the Windows x64 ZIP through Manager or update the Linux container using signed server-manifest.json; restart Server. Downtime interrupts calls. Use Client 0.14.0 for new features; Manager 0.5.1 remains compatible. API/data stay at 2, preserving existing API 2 membership and history. Older Clients read legacy single attachments but need an update for galleries. API 1 is unsupported and has no automatic migration.

## Ограничения / Limitations

Предварительный выпуск. Server видит размеры, ID и отметки списков, но не их зашифрованный текст и медиа. Фото остаются ограничены Client до 2 МиБ. Нет автоматической ротации корневого ключа или forward secrecy; ранее полученные ключи/данные нельзя отозвать. Квоты и удаление истории могут удалять вложения и списки. Внешние сети и промышленная нагрузка требуют отдельной приёмки.

Preview. Server sees sizes, IDs and checklist checks, but not encrypted text or media. Client retains a 2 MiB photo limit. There is no automatic root rotation or forward secrecy; previously retained keys/data cannot be revoked. Quotas and history deletion can remove attachments/checklists. External networks and production load need separate acceptance.

## Файлы и исходники / Assets and source

PawTalk.Server.0.13.0.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.13.0

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.13.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.13.0/LICENSE)

Independent component Ed25519 manifests verify downloads; third-party notices remain included.
Подписи Ed25519 манифестов компонентов проверяют загрузки; сторонние лицензии включены.
