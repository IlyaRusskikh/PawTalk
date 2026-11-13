# Development rules

## Git and approval boundaries

Fetch current `main`, inspect status, preserve unrelated user work. All edits use
working branches from main; direct main commits and force pushes to main are forbidden.
Release branches: `work/{service}-v{version}`; multi-component:
`work/client-vX.Y.Z__server-vX.Y.Z`. Other work uses `work/docs-*`, `work/ci-*`,
`work/chore-*`. Keep a PR to one coherent task including code, tests, both READMEs,
documentation and landing pages as applicable. Push working branches within the
authorized task after affected final-state checks and public diff review.

Merge requires current successful PR CI and separate explicit owner permission.
Default to squash; delete the working branch after merge. Tags require separate
permission and must point to commits contained in main. Publication requires its
own approval after verification/build; a tag approval is not publication approval.
Never replace/delete published tags, binaries or images, or rewrite main history.
Fix post-merge errors in a new branch/PR; a failed pushed release tag gets a new
version. Documentation-only changes need no component release/version bump.

## Context and verification economy

Start with the component map, then targeted search. Read relevant rules only.
Use [test routing](../testing/README.md). Prefer targeted checks during development.
Reuse successful checks only while code, inputs, config, dependencies and execution
environment are unchanged; record command, tree/diff, environment and result in
the task handoff. Rerun checks when their covered state changes. Never hide failures,
skip required integration tests or replace them with a build/unit suite.
Do not run npm ci while other jobs use node_modules; avoid unnecessary installs,
full builds and heavy tests. No test-result hash cache is required.

Before pushing run affected CI checks against the final candidate, inspect output
and exit codes, `npm run check:public`, and staged diff. List unavailable checks.
Local success does not guarantee GitHub success. After opening PR give its direct
CI link and hand control to the owner. Do not poll or watch CI without an explicit
request. Silence while waiting is not merge/tag/publication consent. Initiate each
approval request when that concrete stage is ready; do not infer later approvals.

## Documentation, legal and UI

Keep README.md/README.ru.md aligned; they and the landing pages present PawTalk.
Detailed constraints belong in docs/ and SECURITY.md. Describe real behavior and
limits. A short feature-documentation gap between merge and release is allowed;
use permanent download links, never guessed future assets. Do not make post-release
version-only commits. Preserve historical release descriptions as historical.
Preserve AGPL-3.0-only and third-party notices. Never commit credentials, live
invitations, recordings, personal network reports, CONTINUE.md, manager/generated/,
downloaded tools or build output. No new production dependencies without approval.
Before removing redundant assets from an older release, verify their complete
contents survive in its license archive, preserve the installer/tag, and update
affected checksums/body links. Never replace published binaries. Client assets
remain compact: installer, signed update manifest, SHA256SUMS and one license ZIP
containing LICENSE, THIRD_PARTY_NOTICES.md and licenses/; no duplicate source archive.

Stacked input/select/textarea fields, including conditional E2EE fields, use shared
`.form-fields` with 20px gap; columns use `.form-grid`. No screen-specific spacing
patch or label + label margins. Inspect actual geometry in every affected/nested
dialog. Modal action rows share flex align-items:center, equal minimum button
heights and reset inherited margins; measure button centers. Localize SDK/API enum
values (including quality tooltips), with localized fallback for unknown values.
Check English/Russian, normal/reduced motion, empty/populated clipboard and actual
Electron/native APIs when affected; add regression coverage for CI-only failures.
Do not mock nonexistent platform APIs or rely on workstation defaults.
