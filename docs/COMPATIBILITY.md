# Client ↔ Server compatibility

Release versions are independent. `GET /api/config` adds `apiProtocolVersion: 1`
and `capabilities` (`voice-v1`, `chat-v2`, `profiles-v1`). Missing protocol
means legacy protocol 1; unsupported explicit protocols are rejected with a localized
message before login. Existing chat feature negotiation remains authoritative.

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

Manager 0.2.1 retains signed Server/Manager verification. Existing Server 0.9.0
supports native port changes; IP rebinding requires Server 0.10.1's `serve rebind`.
Upgrade Server first, then Manager and Client; a new Manager EXE alone does not
replace an installed Server or silently accept an unsigned ZIP.

Client 0.10.1 fixes saved-credential reconnects; Manager 0.2.1 fixes Windows service
control without debug privilege and immediate settings language. Neither changes
the protocol or requires a Server release beyond the published 0.10.1.

`shared/protocol.cjs` covers legacy/new/unsupported protocol negotiation.
The frozen published selector fixture tests 0.8.0 → 0.8.1 → Client 0.9.0 discovery.
The updater, manifest verifier and public keys in tags 0.7.1 and 0.8.0 are identical.
Version 0.7.0 has an older case-sensitive GitHub repository-path check: discovery
can fail if GitHub returns another repository casing. That installed binary cannot
be fixed remotely by a new tag; seamless migration is not promised for that build.
`scripts/server-smoke.mjs` can target the immutable published Server 0.8.0 digest;
`--audio` adds two actual Electron/LiveKit clients with synthetic microphones.
Windows self-host and packaged tests exercise the native Electron APIs and bundled binaries.
These are local synthetic checks, not two physical devices or external-network acceptance.

Breaking changes require an explicit matrix update and server-first compatibility
release, then Client, then eventual legacy removal. A higher Client release number
does not require a higher Server release number. Unsupported data schemas are
blocked by the host updater until a tested backup/restore transition is supplied.

## Русский

Поддерживается новый клиент с сервером 0.8.0 по API protocol 1. Отсутствие поля
протокола трактуется как legacy 1; неизвестный явный протокол блокируется до входа
с локализованной ошибкой. Голос/чат проверяются отдельно от relay: старый VPS не
раздаёт новые `client-v*` ассеты. Прямое обновление через GitHub работает независимо.
Windows self-host сохраняется и использует закреплённый commit. Проверки с
синтетическими микрофонами не заменяют реальную сеть и устройства.
