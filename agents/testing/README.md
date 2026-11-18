# Verification routing

Use `node tooling/ci/test-plan.mjs <changed-path> ...` (or `--diff origin/main`)
to get affected suites without executing them. Routing is conservative: unknown
implementation/config paths select all components. PR CI retains the full baseline;
manual and Preflight checks retain component scopes via scripts/ci-scope.mjs.

| Suite | Required commands / coverage |
| --- | --- |
| infrastructure | `node --test tests/infrastructure/agent-infrastructure.test.mjs tests/release/release-catalog.test.mjs tests/infrastructure/ci-scope.test.mjs tests/release/release-routing.test.mjs tests/release/release-metadata.test.mjs tests/release/release-candidate.test.mjs tests/release/candidate-origin.test.mjs`; `node tooling/ci/check-agents.mjs`; `node tooling/ci/check-website.mjs`; `node tooling/ci/website-smoke.mjs` (real Electron); `node tooling/ci/release-image-smoke.mjs` (Docker/local registry); `npm run check:public` |
| client | `npm run build`, `npm test`; affected apps/client/windows/native/Electron/UI/audio smokes from .github/workflows/check.yml; native:build + native-smoke; package and packaged-smoke for installer changes/releases |
| server | in apps/server/: `go test ./...`, `go vet ./...`; Linux CI also race; relevant server-smoke, dev-server --smoke, docker-smoke --containers-only; shared-core equality when both Windows bundles built |
| manager | in apps/manager/windows/service/: `go test ./...`, `go vet ./...`; Python unittest discover tests/*_test.py; actual SCM, desktop/package smokes on Windows; systemd, Compose install/backup/update/restore/crash and Debian-container checks on Linux |
| compatibility | frozen published Server 0.8.0 explicit rejection (`server-smoke.mjs --legacy-rejection`); API 2 source fixtures for current Client/Manager, signed update fixtures; API/protocol/release routing tests and relevant integrations above |

Infrastructure also requires `node tooling/ci/check-release-notes.mjs` and
`node --test tests/release/release-notes.test.mjs`. Selected release candidates repeat notes
validation in shared plan/tag/publish code for both workflows, with no historical
exemptions. Published-note verification is read-only, not a apps/client/windows/build/CI substitute.

Docs/site/agent-only work uses infrastructure checks; implementation changes use
affected component baselines and relevant integration. Shared server core routes
Client+Server+Manager+compatibility because the host lifecycle also consumes it.
Release Candidate Preflight preparation runs every applicable locally available step of check.yml,
plus `node apps/client/windows/scripts/packaged-smoke.mjs` after building Client NSIS. Read workflow
steps for exact environment and flags, not the historical VERIFICATION.md log.

Synthetic audio via real Electron/LiveKit is an integration check, not real-device
acceptance. Docker/Compose checks do not prove external UDP/VPS operation. Native
Linux arm64, Windows runner variants, physical microphones/games/PTT, two external
networks and load acceptance must be reported separately when unavailable locally.

Infrastructure also runs actionlint 1.7.12 over every workflow. Candidate tests use
synthetic signing keys, execute real sealing/validation, reject foreign/corrupt/missing
artifacts and enforce the YAML approval/dependency graph. Local OCI smoke uses an
isolated registry, never GHCR. Hosted reviewer enforcement and production signing
are not simulated as successful release acceptance. Preflight uses component-specific
check.yml modes before tags; publication must only revalidate/download prepared bytes.

Include `tests/release/candidate-origin.test.mjs` in infrastructure checks. It uses mock
GitHub APIs and synthetic ZIPs for source run/job/attempt provenance, pagination,
expiry, archive digests, strict extraction, immutable tags and partial publication.
The Client fixture exercises real seal → saved index → cross-run promotion plan →
tag → publication with synthetic keys, a network-denying API mock and mocked external
writes; original receipts remain unchanged despite a different executing run/attempt.
Python 3.13 is set up for Windows verification, including Client scopes; local Node
tests may set PAWTALK_PYTHON to an existing interpreter's absolute path. No Store
installation is required. These checks do not prove hosted approvals or perform
production writes. Promote Existing Preflight itself runs integrity/provenance checks
only: it must never call check.yml, rebuild packages/OCI or re-sign manifests.
