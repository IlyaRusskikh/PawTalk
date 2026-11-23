# Development and builds

[Русский](development.ru.md) · [Index](README.md)

Development from `main` is **not** proof of availability in a tagged release. Read [AGENTS.md](../AGENTS.md) and the specific [agent rules](../agents/README.md) before editing. Work in a separate branch; no direct pushes to `main`. Building a desktop app requires **Windows x64**, Node.js 24.22.1+, Go 1.27.3+, and Visual Studio Build Tools with C++/Windows SDK. `PAWTALK_GO` can point to a Go executable.

~~~powershell
npm ci
npm run native:build
npm run dev
~~~

Core ownership: Client [React/TypeScript](../apps/client/windows/src), [Electron](../apps/client/windows/electron); shared Server [Go](../apps/server); Windows Manager [Go controller](../apps/manager/windows/service) and [Electron UI](../apps/manager/windows/desktop); Linux Manager [Python](../apps/manager/linux/pawtalk_manager). All network-facing behavior is subject to protocol, release and security tests, not just a local GUI check.

Useful checks are defined by the repository's [package scripts](../package.json), [Go tests](../apps/server) and [CI workflow](../.github/workflows/check.yml). Choose tests according to the changed component and follow the [verification rules](../agents/testing/README.md). Never commit generated assets, private keys, login links, local backups or diagnostic reports.

**Important:** current source and historical test harnesses may diverge from published API 2 binaries. When writing user docs, check immutable release artifacts/notes rather than assuming newest `main` behavior is public.

## Native Server review on Windows

Run **npm run review:server** to build the current shared Go core and launch a persistent development Server with its own LiveKit process. No Manager installation, Windows service or Docker is required. The Server build needs the pinned Go toolchain (PAWTALK_GO is supported); Client native C++ build tools are not needed for this command. The first run prepares the pinned LiveKit binary through the existing verified download path.

Default advertised address is 127.0.0.1 and the port group is 28443–28446, separate from the installed server defaults. The normal Server listeners still bind host interfaces; localhost advertisement is not a firewall rule. Use **npm run review:server -- --ip 192.168.1.10** with this computer's LAN address for another device, and allow that port group in the host firewall when needed. No firewall rules are changed automatically.

Data lives under release/review-server/data; binaries and the private first-administrator invitation file initial-admin.txt stay in that ignored review directory. Start **npm run review** in another terminal and paste the file contents into Join. After first admission, create ordinary invitations from Client. Restarts retain identity, chat and members and remove the stale first-administrator file. Stop with Ctrl+C or **npm run review:server -- --stop**; data remains.

Use **--profile NAME** for an independent server and **--port PORT** for its free group of four ports; include the same profile when stopping. Repeat custom IP/port options on restart. Use a new profile if changing the advertised IP rather than replacing a saved identity. Each launch rebuilds source; an already running profile is rejected. Close and relaunch to pick up code changes. Installed Manager/Server state is never used. This is development source, not a signed release.

Verification: **node scripts/review-server-smoke.mjs** builds/starts the real native Server, joins over pinned TLS, sends encrypted chat, stops/restarts with the same identity/history and checks profile locking. Its synthetic profile is removed afterwards.

## Make review commands on Windows

Install GNU Make (for example, winget install --id ezwinports.make --exact --source winget --scope user), then reopen the terminal so its PATH refreshes. Run make from the repository root; bare make prints help. Existing make installer and make all still build the installer.

- make client-start / make client-stop: build the current Client UI and open/quit its dedicated review profile. Closing the window normally still hides it in the tray. Stop addresses only the instance recorded by this launcher; it never kills processes by executable name.
- `make client-start-first`, `make client-start-second`, `make client-start-third`: run independent Client instances simultaneously. Stop each with `make client-stop-first`, `make client-stop-second`, or `make client-stop-third`. Each name selects its own persistent profile and logs; these commands are equivalent to `make client-start PROFILE=first` / `make client-stop PROFILE=first`. Other profile names are supported too. Start instances sequentially so their builds do not overlap. `make stop` without `PROFILE` stops only the default instance.
- make manager-start / make manager-stop: build the current Manager UI and open/quit its dedicated UI profile. When installed Manager is found in its registry record, use that host backend and data root; actions therefore manage that installed server and may request normal UAC authorization. Otherwise use the locally prepared Manager runtime. This is a UI review, not a separate server installation. Stopping this UI leaves Server services running, and refuses to interrupt a busy Manager operation.
- make server-start / make server-stop: existing native Server review; start stays in the foreground. SERVER_IP, SERVER_PORT and SERVER_PROFILE configure that separate server.
- make stop: stop the selected client, Manager UI and review server. PROFILE=name selects another client/Manager UI profile. Review state/logs live under release/review-apps and are ignored by Git.

The launcher uses authenticated local pipes and graceful application shutdown; no forced process-name termination or new service installation is performed. A repeated start is harmless; a repeated stop succeeds. Validate actual window lifecycle with node tooling/dev/review-app-smoke.mjs; the smoke test denies the Manager privileged broker synthetically instead of elevating or modifying a real host.

New review Server profiles start on API 3. Join with the private owner invitation from the path printed by the launcher. An initialized API 2 review profile saves `api2-before-migration.tar` in its data directory and waits for its owner on the same endpoint. Open that server in the review Client profile that owns it, choose **Migrate server to API 3**, and confirm. The Client uses the local encryption key to prepare the history and signs the cutover. The Server then opens API 3 without another command. Save the recovery bundle shown by the Client in a private place.
