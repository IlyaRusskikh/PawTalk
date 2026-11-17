# Development and builds

[Русский](development.ru.md) · [Index](README.md)

Development from `main` is **not** proof of availability in a tagged release. Read [AGENTS.md](../AGENTS.md) and the specific [agent rules](../agents/README.md) before editing. Work in a separate branch; no direct pushes to `main`. Building a desktop app requires **Windows x64**, Node.js 24.22.1+, Go 1.27.3+, and Visual Studio Build Tools with C++/Windows SDK. `PAWTALK_GO` can point to a Go executable.

~~~powershell
npm ci
npm run native:build
npm run dev
~~~

Core ownership: Client [React/TypeScript](../src/), [Electron](../electron/); shared Server [Go](../server/); Windows Manager [Go controller](../manager/windows/) and [Electron UI](../manager/desktop/); Linux Manager [Python](../manager/pawtalk_manager/). All network-facing behavior is subject to protocol, release and security tests, not just a local GUI check.

Useful checks are defined by the repository's [package scripts](../package.json), [Go tests](../server/) and [CI workflow](../.github/workflows/check.yml). Choose tests according to the changed component and follow the [verification rules](../agents/testing/README.md). Never commit generated assets, private keys, login links, local backups or diagnostic reports.

**Important:** current source and historical test harnesses may diverge from published API 2 binaries. When writing user docs, check immutable release artifacts/notes rather than assuming newest `main` behavior is public.

## Native Server review on Windows

Run **npm run review:server** to build the current shared Go core and launch a persistent development Server with its own LiveKit process. No Manager installation, Windows service or Docker is required. The Server build needs the pinned Go toolchain (PAWTALK_GO is supported); Client native C++ build tools are not needed for this command. The first run prepares the pinned LiveKit binary through the existing verified download path.

Default advertised address is 127.0.0.1 and the port group is 28443–28446, separate from the installed server defaults. The normal Server listeners still bind host interfaces; localhost advertisement is not a firewall rule. Use **npm run review:server -- --ip 192.168.1.10** with this computer's LAN address for another device, and allow that port group in the host firewall when needed. No firewall rules are changed automatically.

Data lives under release/review-server/data; binaries and the private first-administrator invitation file initial-admin.txt stay in that ignored review directory. Start **npm run review** in another terminal and paste the file contents into Join. After first admission, create ordinary invitations from Client. Restarts retain identity, chat and members and remove the stale first-administrator file. Stop with Ctrl+C or **npm run review:server -- --stop**; data remains.

Use **--profile NAME** for an independent server and **--port PORT** for its free group of four ports; include the same profile when stopping. Repeat custom IP/port options on restart. Use a new profile if changing the advertised IP rather than replacing a saved identity. Each launch rebuilds source; an already running profile is rejected. Close and relaunch to pick up code changes. Installed Manager/Server state is never used. This is development source, not a signed release.

Verification: **node scripts/review-server-smoke.mjs** builds/starts the real native Server, joins over pinned TLS, sends encrypted chat, stops/restarts with the same identity/history and checks profile locking. Its synthetic profile is removed afterwards.
