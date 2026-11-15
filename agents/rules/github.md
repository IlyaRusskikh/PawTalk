# Manual GitHub setup (owner action; not applied by repository files)

1. Main branch ruleset: require PR, owner review, successful **Verify and package**
   jobs (server ubuntu-24.04 and ubuntu-24.04-arm; windows windows-2022/windows-2025;
   infrastructure), resolve conversations, block force pushes/deletion. Select exact
   check names after the first PR run; avoid stale push-only contexts. Enforce for
   administrators where feasible; keep any emergency bypass narrow and audited.
2. Enable squash merge as default and automatic branch deletion. A successful CI
   does not grant an agent permission to merge. Do not enable auto-merge for it.
3. Tag rulesets for client-v*, server-v*, manager-v* and historical v*: block updates
   and deletions; restrict creation to authorized maintainers. The release plan
   also rejects tags whose commit is outside main. Do not recreate failed tags.
4. Create **release-tag** AND **release-publish** BEFORE promotion. Both require
   owner/release reviewers and deployment branch policy permitting **main** (the
   dispatch GITHUB_REF remains refs/heads/main even after tag creation). Remove the
   old tag-only release-publish restriction. Disable administrator bypass where
   available. Each approval is independent; an environment name alone is NOT a gate.
   Prevent-self-review needs a second reviewer if the owner dispatches the run.
   Feature availability depends on repository visibility/plan; do not release if
   Required reviewers cannot be enforced. Configure a second reviewer or use a
   protected external/manual promotion process; never silently drop the gate.
5. Keep PAWTALK_UPDATE_PRIVATE_KEY, PAWTALK_SERVER_PRIVATE_KEY and
   PAWTALK_MANAGER_PRIVATE_KEY as independent repository/org secrets available only
   to trusted main preparation steps in release.yml. check.yml has no signing secret
   interface and PRs receive none. Do not move keys into release-publish: signing
   must finish before tag approval. Protect main and workflow changes by review.
   Scoped GITHUB_TOKEN writes refs only in release-tag and Releases only after
   release-publish; only the Server publisher has packages:write. No PAT is needed.
   Ensure tag rulesets permit the intended GITHUB_TOKEN actor to create tags while
   still blocking updates/deletions; owner must verify this before first promotion.
6. Pages source is GitHub Actions. github-pages permits main and component tag
   families for manual release events. Pages uses actions:read to check that a
   completed Release Candidate Preflight or Promote Existing Preflight actually published; prepare-only completion
   is ignored. pages/id-token permissions and GHCR package creation must be allowed.
   API/catalog failure preserves the previous deployment; recover with Pages dispatch.
7. Actions artifacts must remain available through both approvals (7-day retention;
   repository/org limits must permit this and the complete multi-platform OCI size).
   Inspect PR CI check contexts after the first run before adjusting required checks.
   First run: merge this PR only after review/CI; configure settings above; dispatch
   main with components=client (or the intended set), promote=false; inspect component
   readiness, SHA, versions and artifact digests. It creates no production tags/assets.
   For the actual release prefer Promote Existing Preflight with the successful
   prepare-only source_run_id at the unchanged main SHA. It promotes the complete
   original set without rebuilding. A fresh promote=true dispatch remains supported.
   Review source evidence before release-tag, then independently approve release-publish. After
   dispatch the agent provides the run link and hands off; no passive CI polling.
8. Promotion needs GITHUB_TOKEN actions:read to inspect run/attempt jobs and download
   immutable source artifacts; no PAT or signing secret is used. Both protected
   environments still allow main and require independent reviewers. No new environment
   or Settings change is introduced. Preserve the candidate index and all prepared
   packages until publication; missing/expired/foreign/mixed-attempt evidence fails.
   Do not rerun source jobs, delete artifacts, change channels/main or dispatch a
   competing release while a candidate awaits approval. Old candidates without the
   saved index require a fresh Preflight after this infrastructure reaches main.

Review settings in GitHub UI. Repository files cannot prove Required reviewers,
rulesets, artifact limits or GHCR permission are configured. No settings are changed
by local checks. Source versions with existing historical failed tags are rejected;
never delete/reuse those tags. See [release process](../../docs/RELEASING.md).
