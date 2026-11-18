# Component and dependency map

| Owner | Entry points / implementation | Dependencies and boundaries |
| --- | --- | --- |
| Client | `apps/client/windows/src/main.tsx`, `apps/client/windows/src/ServerApp.tsx`, `apps/client/windows/src/ServerChat.tsx`, `apps/client/windows/electron/membership-*.cjs`, `apps/client/windows/src/audio.ts`, `apps/client/windows/electron/main.cjs`, `apps/client/windows/electron/preload.cjs`, `apps/client/windows/native/` | React renderer → allowlisted membership IPC → protected keys/pinned TLS; Electron/native PTT/audio; LiveKit media |
| Temporary host | `apps/client/windows/electron/selfhost.cjs`, `tooling/build/prepare-server.mjs`, `tooling/build/server-core.mjs` | Builds current `apps/server/` in selfhost mode; ephemeral data, not a separate server fork |
| Server | `apps/server/`, `apps/server/VERSION`, `apps/server/deploy/standalone.Dockerfile`, `apps/server/scripts/build-windows-server.mjs` | Go API/auth/chat/storage + LiveKit; serve mode persists identity/data; Windows services or Linux host networking |
| Manager | `apps/manager/linux/pawtalkctl`, `apps/manager/linux/launcher`, `apps/manager/linux/pawtalk_manager/`, `apps/manager/windows/service/`, `apps/manager/windows/desktop/` | Host-only Python controller; Compose/systemd on Linux, Go/SCM and Electron UI on Windows; independent signed updates |
| Shared contracts | `shared/membership.cjs`, `shared/server-crypto.mjs`, `shared/framing.mjs`, `shared/release.cjs`, `shared/encryption.mjs`, `shared/i18n.cjs`, `shared/en.json` | API/data 2, framed signatures, client-only channel crypto, independent component releases and localization |
| Infrastructure | `.github/workflows/`, `scripts/`, `tests/`, `apps/website/` | PR verification, component candidate builds before tags, verified cross-run promotion, gated publication, generated public catalog and Pages |

Version sources: Client apps/client/windows/package.json + its workspace package-lock entry; Server
apps/server/VERSION; Manager apps/manager/VERSION + apps/manager/windows/desktop/package.json. These are
development versions, not proof of a public release. Read [invariants](invariants.md)
before changing cross-component code. See [architecture detail](../../architecture/overview.en.md)
and [shared-core build contract](../../architecture/components.en.md).
