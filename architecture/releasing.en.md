# Independent release process

[Русский](releasing.ru.md) · [Index](README.md)

Release families are `client-vX.Y.Z`, `server-vX.Y.Z` and `manager-vX.Y.Z`. Windows and Linux Manager share **one Manager tag**. Source manifests prepare candidate versions; only published GitHub Releases and their signed assets establish a public version.

1. Prepare a task branch from current `main`. Update the relevant component source versions, compatibility notes, bilingual guides, change history and [canonical release-note sources](../releases/README.md). All notes must be accurate as a public description before and after publication, without unverified claims of CI success or temporary “pending publication” text.
2. Run component-appropriate tests, release-note and documentation/link checks; open a PR only with explicit owner authorization. Merge requires successful PR CI and a separate owner decision.
3. After merge, the separate **Release Candidate Preflight** checks the exact unchanged `main` SHA and prepares signed artifacts. Preparing is **not** tagging or publishing.
4. A separate tag approval and then a publication approval promote the **same prepared bytes**, verifying signatures, hashes, immutable references, channel, API/data schema and exact release body. A failed publication is not retried by silently replacing a tag or binary.
5. Once published, update any derived download catalog only from GitHub Releases; never infer “latest” from a package manifest or hardcode one global `releases/latest`.

The publication scripts consume `releases/<tag>.md` as the **canonical local bilingual publication source**, whose digest is fixed for an approved candidate. A local source may differ from an existing public Release body; see the [recorded differences](../releases/README.md). Human-language navigation is separate from that signed publication contract. Public bodies are not rewritten as part of documentation cleanup. [Release tests](../tests/release/release-notes.test.mjs) · [workflow](../.github/workflows/release.yml).

## Prepare and promote a candidate

Dispatch **Release Candidate Preflight** (`release.yml`) on `main` after merge. Set `components` to `client`, `server`, `manager`, a comma-separated set without spaces, or `all`. The default `promote=false` runs the selected native verification/build/signing scopes and saves the prepared packages, receipts and `pawtalk-candidate-index`; it creates no tags or public releases. Inspect readiness, exact SHA, versions, channels and artifact digests. [GitHub setup and reviewer gates](../agents/rules/github.md) require owner configuration.

When a successful prepare-only run exists at the unchanged current `main` SHA, prefer **Promote Existing Preflight** (`promote-candidate.yml`) with its `source_run_id`. It derives the complete original component set, versions and channels from the saved index and verifies the original run/attempt, mandatory jobs, archive digests, receipts, signatures and OCI digest. It must not rebuild, re-sign or repeat `check.yml`. A fresh `release.yml` dispatch with `promote=true` instead performs a new complete preparation before the approval gates.

Both paths separately require **release-tag** and **release-publish** approval. Preserve source artifacts through both gates; retention is seven days, subject to repository limits. A changed main SHA, expired/missing artifacts, changed source attempt, mismatched versions/channels, missing index or existing tags/releases blocks reuse. Do not rerun source jobs or change main/channels while approval is pending. Older candidates without an index need a new preparation. [Promotion design and rejection rules](../agents/decisions/003-promote-existing-preflight.md).

Tags and GitHub/GHCR publication are not atomic across components. On partial failure, report completed and failed stages, preserve evidence and prepare a new version/PR; do not blindly retry or overwrite tags, assets or images. Only successful publication triggers catalog/Pages deployment; prepare-only completion does not.

## Release note contract (REL-NOTES-01…06)

- **REL-NOTES-01:** The approved description is complete public user documentation before PR merge.
- **REL-NOTES-02:** Do not include transient publication or CI statuses such as “pending publication”, “tag CI pending” or “verification will run”, in either language.
- **REL-NOTES-03:** Do not claim successful CI or publication unless it actually happened.
- **REL-NOTES-04:** GitHub Actions is the source for checks; a run link is optional and only valid after confirmation.
- **REL-NOTES-05:** Notes must remain truthful before and after publishing and when read historically.
- **REL-NOTES-06:** Review both Russian and English for equal factual accuracy.

Each canonical `releases/<tag>.md` contains the exact bilingual body for publishing. Selected notes have a normalized SHA-256 bound in the candidate plan/receipt and cannot change between plan, tag and publication. Three known failed candidates are frozen by hash for historical scanning only; they are not public versions and must not bypass selected-candidate validation. Use `node tooling/ci/check-release-notes.mjs` before any release preparation and `node tooling/ci/check-release-notes.mjs --published <tag>` for a read-only comparison with an existing published GitHub Release. Correcting public text requires **separate owner approval** and must not alter tag, assets, signatures or digest.
