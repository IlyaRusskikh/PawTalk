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
4. Create **release-publish** environment BEFORE releasing. Set Required reviewers
   to the owner/release reviewers and restrict deployment tags to the three component
   families. Disable administrator bypass where available. A sole owner who triggers
   tags must be able to approve separately; prevent-self-review requires a second
   reviewer. Reviewers require repository read access; feature availability depends
   on repository visibility/plan. An environment name in YAML alone is NOT a gate.
5. Signing keys: existing PAWTALK_UPDATE_PRIVATE_KEY stays available only to trusted
   tag Client verification; PAWTALK_SERVER_PRIVATE_KEY and PAWTALK_MANAGER_PRIVATE_KEY
   sign in preparation jobs before publication approval. Keep these repository/org
   secrets available to trusted tag jobs, never fork PRs. Moving them into
   release-publish would block preparation; a separate protected signing environment
   is possible but requires workflow changes. Publication uses scoped GITHUB_TOKEN
   contents:write; only Server has packages:write. No personal token is required.
6. Pages source: GitHub Actions, github-pages environment permitting main AND the
   component tag families (release events keep the tag ref even when checkout uses main); Actions
   pages/id-token permissions and GHCR package creation access. Successful release
   workflow completion regenerates Pages from main (release events caused by
   GITHUB_TOKEN do not reliably chain workflows). Manual releases use release:
   published; manual dispatch recovers API/deployment failures. No settings are
   changed by local tests. Bootstrap Pages after merging this infrastructure.

Review repo rules/security settings in the GitHub UI. Files document desired
settings; they cannot prove the protected environment or rulesets are configured.
