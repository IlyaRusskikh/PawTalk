# Component and dependency map

| Owner | Entry points / implementation | Dependencies and boundaries |
| --- | --- | --- |
| Client | `src/main.tsx`, `src/ServerApp.tsx`, `src/ServerChat.tsx`, `electron/membership-*.cjs`, `src/audio.ts`, `electron/main.cjs`, `electron/preload.cjs`, `native/` | React renderer → allowlisted membership IPC → protected keys/pinned TLS; Electron/native PTT/audio; LiveKit media |
| Temporary host | `electron/selfhost.cjs`, `scripts/prepare-server.mjs`, `scripts/server-core.mjs` | Builds current `server/` in selfhost mode; ephemeral data, not a separate server fork |
| Server | `server/`, `server/VERSION`, `server/standalone.Dockerfile`, `scripts/build-windows-server.mjs` | Go API/auth/chat/storage + LiveKit; serve mode persists identity/data; Windows services or Linux host networking |
| Manager | `manager/pawtalkctl`, `manager/launcher`, `manager/pawtalk_manager/`, `manager/windows/`, `manager/desktop/` | Host-only Python controller; Compose/systemd on Linux, Go/SCM and Electron UI on Windows; independent signed updates |
| Shared contracts | `shared/membership.cjs`, `shared/server-crypto.mjs`, `shared/framing.mjs`, `shared/release.cjs`, `shared/encryption.mjs`, `shared/i18n.cjs`, `shared/en.json` | API/data 2, framed signatures, client-only channel crypto, independent component releases and localization |
| Infrastructure | `.github/workflows/`, `scripts/`, `tests/`, `website/` | PR verification, component candidate builds before tags, verified cross-run promotion, gated publication, generated public catalog and Pages |

Version sources: Client package.json + both package-lock version fields; Server
server/VERSION; Manager manager/VERSION + manager/desktop/package.json. These are
development versions, not proof of a public release. Read [invariants](invariants.md)
before changing cross-component code. See [architecture detail](../../architecture/overview.en.md)
and [shared-core build contract](../../architecture/components.en.md).
