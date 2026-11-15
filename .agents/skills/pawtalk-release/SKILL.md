---
name: pawtalk-release
description: Prepare or publish an explicitly requested PawTalk component release with independent versions, bilingual notes and separate merge, tag and publication approvals.
metadata:
  short-description: Prepare and gate component releases
---

1. Read [release process](../../../docs/RELEASING.md),
   [Git rules](../../../agents/rules/development.md) and
   [GitHub setup](../../../agents/rules/github.md). Determine the component and
   previous published release using GitHub Releases, not source versions.
2. In work/{service}-v{version} from current main prepare independent version
   sources, CHANGELOG and reviewed RU/EN docs/releases/<tag>.md with exact assets,
   upgrade requirements and limitations. Follow REL-NOTES-01…06 in RELEASING.md:
   write final public text before PR merge, accurate before and after publication;
   review RU/EN equally. No pending CI/publication statuses or advance success claims.
   Actual results belong in Actions; confirmed run links are optional. Preserve
   accurate history of failed earlier tags. Existing public body corrections need
   separate owner approval; use docs/RELEASE-NOTES-RECOVERY.md without replacing assets.
3. Run applicable final-state CI locally plus packaged smoke after Client installer;
   report unavailable environments. Run node scripts/check-release-notes.mjs and
   its tests; selected-candidate checks never exempt historical failed drafts.
   Review diff/public guard; push branch and PR when authorized by the user.
4. Hand off PR CI link without polling. Successful CI plus explicit owner merge
   permission precede squash merge; delete branch. After merge initiate Preflight
   on exact main SHA with selected component versions; all PR CI is not release proof.
5. Use dispatch-only release.yml: promote=false safely prepares without tags or
   publication. When a successful prepare-only candidate already exists, prefer
   Promote Existing Preflight with its source_run_id on the exact unchanged main SHA.
   Promote the entire original set; derive versions/channels from the saved index,
   verify API run/workflow/attempt jobs and immutable archive digests, original
   receipts/signatures and OCI digest, and retain the original run ID/attempt.
   Never replace GITHUB_* or rebuild/re-sign missing/invalid artifacts. Missing index,
   stale main, expiry, mixed attempts or existing tags/releases require rejection.
   The alternative promote=true runs all selected release scopes, real builds,
   signatures and receipt validation BEFORE requesting release-tag approval. Agent
   initiates the required approval when ready, gives its direct run URL and hands
   control to owner; never passively monitor CI without instruction. No tag on failed
   Preflight, stale SHA or absent/corrupt/foreign artifacts.
6. After separate release-tag approval, only checked immutable tags are created.
   Then request separate release-publish approval. Publishers revalidate source/run,
   signatures, exact prepared bytes and notesSha256; no rebuild/re-sign. Check draft
   title/tag/channel/full body/links/assets before visibility and again afterward.
   Stop on mismatch without automatic overwrite/retry. Both environments need
   main deployment permission and Required reviewers configured by owner.
   Do not edit main/channels or rerun/delete source artifacts during review. Promotion
   rechecks and pins source evidence at both gates, shares the release concurrency
   group and has no signing secrets. Existing candidates pre-dating the saved index
   cannot be retroactively upgraded; prepare a future candidate on the final main SHA.
7. Never replace tags/assets/images or publish partial/failed releases. Multi-tag
   API writes and GitHub/GHCR publication are not atomic. Report partial failures,
   preserve diagnostics and prepare a new version/PR; no blind promotion retry.
   No release/version bump for infrastructure/docs-only work. Pages derives public
   links from successful publication. No settings, merge, tag or publication without
   the corresponding explicit owner permission.
