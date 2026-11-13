# 001 — Shared agent knowledge and public release discovery

Status: accepted for this implementation; GitHub settings require owner action.

Context: independent component versions already exist, but descriptive documents
and website downloads drifted. Push+PR CI duplicated the same heavy checks and
publish jobs lacked a separate approval boundary.

Decision: keep one concise AGENTS.md with an indexed knowledge tree and four
task-specific skills. Native tool adapters point to this tree. Development CI runs
on PR, manual scopes and reusable tag checks stay intact. Tag ancestry must be in
main; verification and OCI/package/signing preparation precede release-publish.
Publication creates a draft with complete assets, then publishes it. Server OCI
copy preserves the prepared digest; signing keys remain in trusted preparation
jobs. Publication and tag permission are distinct.

GitHub Releases is the sole source of public versions. Generate untracked
website/releases.json from all API pages, strict component SemVer, uploaded nonempty
mandatory assets and canonical GitHub URLs. Per component expose latest (including
preview), stable and preview. Latest includes previews to match the project's
current public-preview distribution; stable never silently selects preview.
Equal SemVer precedence uses deterministic tag order; publication dates do not
override SemVer. Legacy v* stays historical and cannot displace component tags.

Permanent /downloads/#client, #server, #manager pages resolve only actual catalog
assets; they are landing addresses, not HTTP binary redirects. Without JS/network,
links remain absent and an error is shown. API/build failure aborts deployment,
preserving the last successful Pages deployment (which can be stale). No committed
fallback versions, guessed URLs, per-release link commits or /releases/latest.
Updater discovery/signature code is intentionally independent.

Alternatives: README regeneration commits create drift/extra commits; global
latest mixes component lines; a server-side redirect needs new hosting. None are
needed. No production dependency or test cache is added.

Limits: GitHub release+GHCR publication is not atomic. A registry upload followed
by GitHub failure may leave an orphan immutable image/draft; do not overwrite or
retry that version blindly, investigate and prepare a new version. Required
reviewers and rulesets are external configuration. Local tests cannot prove hosted
approvals, native Linux arm64 or physical audio/network behavior.
