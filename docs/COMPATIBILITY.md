# Client ↔ Server ↔ Manager compatibility

Published components and current source use [API 2](API-V2.md), mandatory E2EE and data schema 2.
Client, selfhost, permanent Windows/Linux Server and Manager use that contract.
API 2 is a published breaking update with no API 1 migration. Historical binaries
remain unchanged; source package versions do not announce new public releases.
Select future versions from [GitHub Releases](https://ilyarusskikh.github.io/PawTalk/downloads/)
and their component-specific requirements. Install a fresh Linux VPS with the
**[Linux guide](SERVER-LINUX.md)**.

Published compatible preview snapshot, 15 November 2026:
[Client 0.12.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/client-v0.12.1),
[Server 0.11.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/server-v0.11.1),
[Manager 0.5.1](https://github.com/IlyaRusskikh/PawTalk/releases/tag/manager-v0.5.1).
This dated combination is not a permanent version pin or a claim that all future
releases are compatible.

| Client | Server | Manager | Result |
| --- | --- | --- | --- |
| Published API 2 | Published API/data 2 | Published API/data 2 Manager | Supported for the published combination above; read each later release's requirements |
| API 2 source | API 2 source | API/data 2 source | Supported; current shared core, timed invitations, membership and channels |
| API 2 source | API 1 / missing protocol | Any | Rejected before identity/admission proofs; no fallback |
| API 1 published | API 2 source | Any | Legacy API endpoints reject with HTTP 426 |
| Any | Unknown explicit API | Any | Rejected |
| API 2 | API/data 2 | Legacy Manager | Unsupported management/admission contract |
| API 2 | API/data 1 | API/data 2 Manager | Install/update/restore rejected; no migration |

GET /api/config declares apiProtocolVersion:2, capabilities, mandatory E2EE and a
signed server identity bound to the actual TLS fingerprint/origin. Missing protocol
is no longer accepted. Component release numbers are independent of these fields.

The data schema is fresh: membership-v2.sqlite, separate host state and OS-protected
client identities/roots. No bookmark/password/history migration or dual production
core exists. Old data is not deleted automatically; use a clean configuration/data
root. Manager backup/update validation requires API/data 2. Archive signing schema,
Manager config schema and launcher/SCM protocol remain independently versioned at 1.

Client selfhost and permanent Windows Server build the same server/ and LiveKit
with the same flags/toolchain; check-server-core.mjs verifies byte equality.
Selfhost stores history in memory; serve persists schema 2. Updating Server does
not replace an installed Client, and updating Manager does not replace Server.
For a fresh deployment use compatible Manager/Server and Client; subsequent update
order follows each release's requirements. A protocol transition needs server-side
support before clients use it; this does not provide API 1 migration.
[Operator guide](SERVER-API2.md).

Verification includes native Windows main/preload/OS vault/TLS, real API 2 RTP,
Linux Compose install/update/rollback/restore, signed package fixtures, and explicit
rejection of immutable published Server 0.8.0 through server-smoke.mjs
--legacy-rejection. Hardware, external networks, native SCM/systemd availability
are reported separately in [the implementation journal](MULTICHANNEL-PLAN.md).

## Historical published API 1 matrix

The following rows describe historical published binaries only. They do not define
compatibility of published API 2 or current source builds; those binaries stay unchanged.

| Client | Server | Contract |
|---|---|---|
| 0.8.0 | 0.8.0 | Historical baseline; legacy updater sees `v0.8.1` only |
| 0.8.1 bridge | 0.8.0 | Existing protocol 1 features; new Client assets need direct GitHub |
| 0.9.0 | 0.8.0 | Supported protocol 1 voice/auth/chat; new-tag relay is unavailable on old VPS |
| 0.9.0 | 0.9.0 | Protocol 1 + Client-family relay; persistent Compose lifecycle |
| 0.9.0 self-host | pinned Go 0.8.0 + commit in `bundled-server.json` | Temporary room; pinned LiveKit; new Client-tag relay present in pin |
| 0.10.0–0.10.1 | 0.9.0 | Protocol 1 login/voice; Client hides anonymous activity, but old Server still exposes its public counter |
| 0.10.0–0.10.1 | 0.10.1 | Authorized activity only; password reset revokes native voice/chat/preview tokens; stable verified-room bookmarks |
| 0.10.0–0.10.1 self-host | pinned Go 0.8.0 + hashed security backport | Anonymous occupancy denied by the embedded API as well as the Client |
| 0.11.0 | 0.10.1 | Protocol 1; no permanent Server/Manager upgrade required for this Client |
| 0.11.0 self-host | shared server/ 0.10.1 | Current shared core; ephemeral chat, authorized activity and optional E2EE |

Historical Client 0.10.1 retains its pinned/backported core; published Client 0.11.0
introduced the shared core while retaining API 1. Historical missing protocol meant
legacy 1. Frozen updater tests retain the 0.8.0 → 0.8.1 → Client 0.9.0 discovery
bridge; executable update trust and API compatibility are separate contracts.
Old 0.7.0 repository-case discovery limitations are not fixed in installed binaries.

## Русский

Опубликованные Client/Server/Manager и текущие исходники используют API 2 и схему данных 2.
API 1, отсутствие версии и неизвестный протокол отклоняются до передачи личности.
Это опубликованный несовместимый переход: миграции старых настроек/истории/закладок
нет, требуется чистое состояние, старые файлы сами не удаляются. Старые опубликованные
бинарники остаются прежними; историческая таблица выше относится только к ним.

На 15 ноября 2026 года опубликована совместимая preview-комбинация Client 0.12.1,
Server 0.11.1, Manager 0.5.1 (ссылки выше). Это датированный снимок; актуальные версии
выбираются из GitHub Releases с учётом условий каждого выпуска. Основная инструкция
нового Linux VPS — [установка на Linux VPS](SERVER-LINUX.md).

Ключи создаёт и хранит клиент; E2EE обязательно. Временный и постоянный хосты
собирают одно ядро, различаются сроком жизни/хранением. Для чистой установки нужны
совместимые Manager/Server и Client; порядок последующих обновлений задаётся
условиями выпуска. Новый протокол требует поддержки сервера до использования
клиентом, но это не означает миграцию API 1. Версии выпусков независимы от API, схемы БД,
формата подписей и протокола launcher. Проверки физических устройств, внешней сети
и нативных SCM/systemd не подменяются локальными синтетическими тестами.

Server-name management requires the current core endpoint PATCH /api/v2/server.
Existing API 2 databases already contain server_state.name; no schema change is
needed. Update the permanent core before using the new admin rename action; an
older API 2 core returns NOT_FOUND for that action. Renaming preserves server ID,
TLS/E2EE identity and existing memberships. Windows notification previews remain
local: plaintext is produced after client decryption, never added to Server storage.

API 2 follow-up: authenticated membership denials may include optional error.details
(expiresAt for bans, membershipState for departures); older peers retain code-only
behavior. Link status optionally includes sourceNickname/targetNickname for the two
proven participants; names are display metadata, outside the signed identity transcript.
No schema or API version change. Rebuild the shared Server core for these details.
