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
