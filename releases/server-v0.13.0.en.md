# PawTalk Server 0.13.0 — Encrypted media galleries and live checklists

[Русский](server-v0.13.0.ru.md) · [Canonical bilingual source](server-v0.13.0.md)

Preview for Windows x64 and Linux amd64/arm64; changes since Server 0.12.0.
Предварительная версия; изменения относительно Server 0.12.0.

[Download / Скачать](https://github.com/IlyaRusskikh/PawTalk/releases/download/server-v0.13.0/PawTalk.Server.0.13.0.windows-x64.zip)

### Added

- media-files-v1 permits up to 50 MiB of encrypted-attachment plaintext. Startup transactionally expands the previous table limit while preserving data, indexes and ownership checks.
- media-gallery-v1 binds up to twenty unique attachment IDs per message for ten files and their posters. Binding is atomic; replay compares the complete ID set independently of order and rejects duplicates. Up to twenty pending uploads per device expire after thirty minutes, subject to existing storage quotas.
- checklists-v1 stores opaque item IDs and an everyone/author checking policy, validates permissions and makes mutations idempotent. Titles and item text remain encrypted. Edits retain checks for surviving IDs and discard removed IDs.
- checklist-events-v1 includes checks in committed message events and advances channel revisions; Client rejects stale snapshots and recovers gaps over HTTP.

### Install or update

Back up and stop the permanent Server. Import the Windows x64 ZIP through Manager or update the Linux container using signed server-manifest.json; restart Server. Downtime interrupts calls. Use Client 0.14.0 for new features; Manager 0.5.1 remains compatible. API/data stay at 2, preserving existing API 2 membership and history. Older Clients read legacy single attachments but need an update for galleries. API 1 is unsupported and has no automatic migration.

## Limitations

Preview. Server sees sizes, IDs and checklist checks, but not encrypted text or media. Client retains a 2 MiB photo limit. There is no automatic root rotation or forward secrecy; previously retained keys/data cannot be revoked. Quotas and history deletion can remove attachments/checklists. External networks and production load need separate acceptance.

## Файлы и исходники / Assets and source

PawTalk.Server.0.13.0.windows-x64.zip · server-manifest.json · Linux amd64/arm64: ghcr.io/ilyarusskikh/pawtalk-server:0.13.0

[Source / Исходники](https://github.com/IlyaRusskikh/PawTalk/tree/server-v0.13.0) · [AGPL-3.0-only](https://github.com/IlyaRusskikh/PawTalk/blob/server-v0.13.0/LICENSE)

Independent component Ed25519 manifests verify downloads; third-party notices remain included.
Подписи Ed25519 манифестов компонентов проверяют загрузки; сторонние лицензии включены.
