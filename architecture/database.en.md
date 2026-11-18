# Data model and persistence

[Русский](database.ru.md) · [Index](README.md)

API 2 uses **SQLite STRICT schema 2** for permanent servers. Its authoritative DDL (columns, foreign keys, checks, indexes and triggers) is [`apps/server/membership.sql`](../apps/server/membership.sql). The persisted membership database is `membership-v2.sqlite`; the Server runtime also stores local TLS/media configuration in `state.json`. A temporary Client selfhost holds membership/chat in memory instead.

Key logical entities include server-local device and member identities, roles/bans, invitation reservations and key packages, linked devices, text/voice channels, encrypted messages/edits and encrypted attachments. Server membership and channel identifiers bind cryptographic contexts. An application may expose unread state or local display choices independently of persistent server storage.

**No migration:** an API 1 `chat.sqlite` or historic backup must not be opened as schema 2. Updaters and Manager restore validate schema compatibility and release receipts before replacing live state. Persistent server backups retain encrypted content and identities, not Client-stored encryption roots.

**Durability:** Server's managed updates/restore employ backup and rollback transactions, with service interruptions. Remove neither transaction journals nor backing volumes to fix failures. See [Linux maintenance](../docs/manager/linux/maintenance.en.md) and [Windows maintenance](../docs/manager/windows/maintenance.en.md).
