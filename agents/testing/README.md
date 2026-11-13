# Verification routing

Use `node scripts/test-plan.mjs <changed-path> ...` (or `--diff origin/main`)
to get affected suites without executing them. Routing is conservative: unknown
implementation/config paths select all components. PR CI retains the full baseline;
manual and tag checks retain component scopes via scripts/ci-scope.mjs.

| Suite | Required commands / coverage |
| --- | --- |
| infrastructure | `node --test tests/agent-infrastructure.test.mjs tests/release-catalog.test.mjs tests/ci-scope.test.mjs tests/release-routing.test.mjs tests/release-metadata.test.mjs`; `node scripts/check-agents.mjs`; `node scripts/check-website.mjs`; `node scripts/website-smoke.mjs` (real Electron); `node scripts/release-image-smoke.mjs` (Docker/local registry); `npm run check:public` |
| client | `npm run build`, `npm test`; affected native/Electron/UI/audio smokes from .github/workflows/check.yml; native:build + native-smoke; package and packaged-smoke for installer changes/releases |
| server | in server/: `go test ./...`, `go vet ./...`; Linux CI also race; relevant server-smoke, dev-server --smoke, docker-smoke --containers-only; shared-core equality when both Windows bundles built |
| manager | in manager/windows/: `go test ./...`, `go vet ./...`; Python unittest discover tests/*_test.py; actual SCM, desktop/package smokes on Windows; systemd, Compose install/backup/update/restore/crash and Debian-container checks on Linux |
| compatibility | frozen published Server 0.8.0 smoke, signed published test fixtures; API/protocol and release routing tests; relevant cross-component integration above |

Docs/site/agent-only work uses infrastructure checks; implementation changes use
affected component baselines and relevant integration. Shared server core routes
Client+Server+Manager+compatibility because the host lifecycle also consumes it.
Release/tag preparation runs every applicable locally available step of check.yml,
plus `node scripts/packaged-smoke.mjs` after building Client NSIS. Read workflow
steps for exact environment and flags, not the historical VERIFICATION.md log.

Synthetic audio via real Electron/LiveKit is an integration check, not real-device
acceptance. Docker/Compose checks do not prove external UDP/VPS operation. Native
Linux arm64, Windows runner variants, physical microphones/games/PTT, two external
networks and load acceptance must be reported separately when unavailable locally.
