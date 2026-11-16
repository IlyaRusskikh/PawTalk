# 002 — Prepare and verify before immutable release tags

Status: implemented; protected GitHub environment settings require owner action.

Problem: successful PR `all` verification did not exercise every release scope.
Client 0.12.0 failed selfhost shutdown on Windows 2022; Server 0.11.0 lacked the
renderer for SCM integration; Manager 0.5.0 lacked LiveKit for its Server fixture.
PR #14 corrected these dependencies/shutdown behavior and was merged at
`d02c07f71594bc126512a077738ce827fee17739` before this work. Historical tags stay intact.

Decision: replace tag-triggered release.yml with trusted-main workflow_dispatch.
Run the existing check.yml once per selected component, using its actual release
scope on both Windows and Ubuntu architectures. Share only equivalent infrastructure
checks; separate integration scopes intentionally retain different branches/fixtures.
When Client and Server are selected, compare their separately built core receipts
and actual Server ZIP binaries before signing. Preserve the PR `all` baseline.

Prepare all real packages, signatures and multi-platform OCI without production
writes. Receipts bind source SHA, repository, workflow run/attempt, versions/channels
and every byte hash/size; preparation output digests independently anchor receipts.
Use same-run immutable Actions artifacts rather than an external cache. Recheck
signatures, receipts and unchanged main before both tag creation and publication.

`promote=false` is the default safe preparation-only path. `promote=true` requests
release-tag approval only after complete successful Preflight, then separate
release-publish approvals. Publication can only download/validate/copy/upload,
never build or sign. Only Server publication has registry write permission.
Pages checks actual successful publisher jobs and ignores prepare-only completion.
GITHUB_TOKEN does not normally chain push workflows; no tag trigger remains anyway.

Alternatives rejected: PR `all` as release proof misses component conditions;
duplicate simplified preflight drifts from real packaging; post-tag builds can
leave orphan immutable tags; production staging images would publish before approval.

Limits: Required reviewers, main deployment policies, ruleset actor permission,
artifact retention/size and repository access remain external settings. Signing
keys must match existing roots. REST multi-tag creation is not atomic, nor are
GHCR and GitHub Releases. Partial tags/images/drafts/releases can survive failure;
do not retry/overwrite a version without a separately agreed policy change.
Changing main, run attempt or relevant signing/build inputs requires a new candidate.
Local synthetic signing, YAML tests, actionlint and isolated OCI roundtrip cannot
prove hosted approvals, production signing, native runner variants or hardware.

See [release process](../../architecture/releasing.en.md) and
[owner settings/first run](../rules/github.md).
