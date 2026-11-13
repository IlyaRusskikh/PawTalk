# Component and dependency map

| Owner | Entry points / implementation | Dependencies and boundaries |
| --- | --- | --- |
| Client | `src/main.tsx`, `src/App.tsx`, `src/audio.ts`, `electron/main.cjs`, `electron/preload.cjs`, `native/` | React renderer → narrow IPC → Electron/native PTT/audio; LiveKit media; `shared/` contracts |
| Temporary host | `electron/selfhost.cjs`, `scripts/prepare-server.mjs`, `scripts/server-core.mjs` | Builds current `server/` in selfhost mode; ephemeral data, not a separate server fork |
| Server | `server/`, `server/VERSION`, `server/standalone.Dockerfile`, `scripts/build-windows-server.mjs` | Go API/auth/chat/storage + LiveKit; serve mode persists identity/data; Windows services or Linux host networking |
| Manager | `manager/pawtalkctl`, `manager/launcher`, `manager/pawtalk_manager/`, `manager/windows/`, `manager/desktop/` | Host-only Python controller; Compose/systemd on Linux, Go/SCM and Electron UI on Windows; independent signed updates |
| Shared contracts | `shared/protocol.cjs`, `shared/release.cjs`, `shared/encryption.mjs`, `shared/i18n.cjs`, `shared/en.json` | API capability/version negotiation, component release routing, client crypto and localization |
| Infrastructure | `.github/workflows/`, `scripts/`, `tests/`, `website/` | PR verification, component tag builds, gated publication, generated public catalog and Pages |

Version sources: Client package.json + both package-lock version fields; Server
server/VERSION; Manager manager/VERSION + manager/desktop/package.json. These are
development versions, not proof of a public release. Read [invariants](invariants.md)
before changing cross-component code. See [architecture detail](../../docs/ARCHITECTURE.md)
and [shared-core build contract](../../docs/BUNDLED-SERVER.md).
