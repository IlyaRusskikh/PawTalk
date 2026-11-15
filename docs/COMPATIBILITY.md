# Client ↔ Server ↔ Manager compatibility

Current source uses [API 2](API-V2.md), mandatory E2EE and data schema 2.
Client, selfhost, permanent Windows/Linux Server and Manager use that contract.
This is an unreleased breaking update: no published binary is modified and source
package versions do not announce new public releases.

| Client | Server | Manager | Result |
| --- | --- | --- | --- |
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
Supply Server first, then matching Manager/Client. [Operator guide](SERVER-API2.md).

Verification includes native Windows main/preload/OS vault/TLS, real API 2 RTP,
Linux Compose install/update/rollback/restore, signed package fixtures, and explicit
rejection of immutable published Server 0.8.0 through server-smoke.mjs
--legacy-rejection. Hardware, external networks, native SCM/systemd availability
are reported separately in [the implementation journal](MULTICHANNEL-PLAN.md).

## Historical published API 1 matrix

The following rows describe historical published binaries only. They do not define
compatibility of API 2 source builds and are not changed by this update.

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

Текущие исходники Client/Server/Manager используют API 2 и схему данных 2.
API 1, отсутствие версии и неизвестный протокол отклоняются до передачи личности.
Это ещё не опубликованный breaking update: миграции старых настроек/истории/закладок
нет, требуется чистое состояние, старые файлы сами не удаляются. Старые опубликованные
бинарники остаются прежними; историческая таблица выше относится только к ним.

Ключи создаёт и хранит клиент; E2EE обязательно. Временный и постоянный хосты
собирают одно ядро, различаются сроком жизни/хранением. Server поставляется первым,
затем совместимые Manager и Client. Версии выпусков независимы от API, схемы БД,
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
