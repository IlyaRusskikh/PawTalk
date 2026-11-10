# Working on PawTalk

- Keep the English `README.md` and Russian `README.ru.md` consistent when changing
  setup or user-visible features. Detailed existing documentation is in `docs/`.
- The original project is licensed `AGPL-3.0-only`. Preserve third-party notices.
- Do not commit secrets, real room invitations, local network reports, personal
  recordings, `CONTINUE.md`, `deploy/generated/`, downloaded tools or build output.
- Before publication run `npm run check:public` and review staged content.
  The guard is heuristic and does not replace reviewing the diff.
- Run checks appropriate to the change. Client baseline: `npm run build`,
  `npm test`. Go baseline inside `server`: `go test ./...`, `go vet ./...`.
  Audio and networking changes need relevant smoke/integration checks; distinguish
  synthetic checks from real-device and external-network verification.
- Before pushing changes, run the affected CI checks locally against the final
  candidate, fix failures, and inspect their exit codes and output. Before a
  release/tag push, run every applicable locally available step from
  `.github/workflows/check.yml`, plus `node scripts/packaged-smoke.mjs` after
  building the installer. Check website changes with `node scripts/check-website.mjs`.
  Do not substitute a successful build or unit suite for integration checks.
  If a later change affects a verified behavior, rerun its checks before pushing.
- Reproduce CI environment differences explicitly: test both normal/reduced
  motion, empty/populated clipboard representations, Russian/English UI, and
  the actual Electron/native API. Add regression coverage for each CI-only failure.
  Do not mock nonexistent platform APIs or assume workstation defaults match CI.
  Do not run `npm ci` while build/test processes use `node_modules`.
- Report which pre-push checks passed and which could not run locally (such as
  native Linux/arm64 or unavailable Docker). Never claim local success guarantees
  GitHub success. After pushing, distinguish a branch run from the release-tag
  run; give the user the tag workflow URL when handing off CI monitoring.
- When asked to release, follow `docs/RELEASING.md`: X.Y.Z uses Z for small fixes,
  Y for substantial changes and X for very large changes. Reset lower components.
  Update both package manifests, CHANGELOG, and version-specific documentation.
  Start at 0.1.0. Do not bump versions for every work-in-progress edit.
- Local builds must not automatically publish. Component tags are `client-vX.Y.Z`,
  `server-vX.Y.Z`, `deploy-vX.Y.Z` and must match their own version sources.
  The one-time Client bridge uses `v0.8.1` from commit 3747a0d; historical tags
  remain immutable. Never replace published tags or binaries.
- Keep release assets compact: `PawTalk.Setup.X.Y.Z.exe`, `SHA256SUMS.txt`,
  and one `PawTalk.Licenses.X.Y.Z.zip` containing `LICENSE`,
  `THIRD_PARTY_NOTICES.md`, and `licenses/` from that release. Do not attach
  individual license files or a duplicate source archive; keep GitHub's automatic
  Source code ZIP/TAR downloads. Hash the exact uploaded EXE. Before removing
  redundant assets from an older release, verify their contents are preserved in
  the archive; preserve the installer/tag and update affected checksum/body links.
- Group stacked input/select/textarea fields in the shared `.form-fields`
  container with a 20px gap; use the shared `.form-grid` for columns. Include
  conditional fields such as the E2EE key in the same group. Do not fix spacing
  with a rule scoped to a single screen or `label + label` margins. Check actual
  field geometry in each affected modal, including conditional/nested dialogs.
- Align modal action buttons with a shared flex row (`align-items: center`),
  equal minimum height and reset inherited button margins inside that row.
  Verify button centers, not just the containing row.
- Translate SDK/API enum values before displaying them (including connection
  quality in tooltips); unknown values must use a localized fallback. Check both
  Russian and English UI, not just the surrounding label.
