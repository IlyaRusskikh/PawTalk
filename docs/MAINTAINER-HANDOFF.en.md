# Documentation migration — review handoff

[Русский](MAINTAINER-HANDOFF.ru.md) · [Documentation](README.md)

This branch replaces the user/technical documentation **from scratch**, moves all canonical release bodies to root `releases/`, and updates the release-note paths, agent references, website copy and documentation CI. There is **no PR** and no merge/tag/release action. The following verification still needs a local checkout or Codex on the branch.

## Required local audit

~~~bash
git fetch origin
git switch docs/complete-refresh-2026-11-16
git status --short
node scripts/check-docs.mjs
node scripts/check-release-notes.mjs
node --test tests/documentation.test.mjs tests/release-notes.test.mjs tests/agent-infrastructure.test.mjs
node scripts/check-agents.mjs
node scripts/check-website.mjs
npm run check:public
~~~

Install dependencies with `npm ci` only in an isolated environment before broader test suites. Run all applicable [CI workflows](../.github/workflows/check.yml), including the release-candidate tests, and review any failed job rather than skipping it. Compare release scripts/fixtures for paths still referring to `docs/releases/`. Do **not** run release publication or issue new tags.

## Manual review

1. Compare every RU/EN page for meaning, not just file existence. Check exact UI text on the **published** Client and Windows Manager.
2. Audit the Linux CLI commands on a safe supported Debian 12 or Ubuntu 24.04 LTS host. Do not apply install/uninstall/restore to a production host without a backup.
3. Compare technical architecture with the published tag sources and actual Go API/SQLite schema. The architecture docs are a **map**; they are not an exhaustive generated endpoint specification.
4. Verify links and the static Pages layout in both locales. The website's old 0.7.x screenshots remain **historical illustrations**; capture fresh, sanitized images with the **published API 2 Client** before presenting them as current.
5. Review translated per-release pages in `releases/<tag>.en.md` and `.ru.md` against canonical local `releases/<tag>.md` sources. Their bytes are preserved from the previous documentation tree for digest/CI; they are not necessarily exact copies of public Release bodies. See the [recorded differences](../releases/README.md). Three failed candidate tags must stay classified as unpublished.
6. Confirm new changelog summaries for historical unified Voicecord/PawTalk tags. Early tags do not prove independent Client/Server/Manager binaries.

## Open limitations

This GitHub-only edit environment cannot execute the repository's npm/Go/Python/Windows/Linux integration tests or recreate signed release binaries and current screenshots. **No test success is asserted.** The original snapshot texts may contain immutable historic links to documents inside old tags; these are intentional and must not be rewritten as active instructions.

Do not create a PR until the owner asks. Fix any issues in this same branch, then present the final audit results and diff for owner approval.
