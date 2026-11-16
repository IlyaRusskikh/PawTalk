# 003 — Promote an original Preflight without rebuilding

Status: implemented for future candidates; no GitHub Settings are changed.

Problem: prepare-only candidates could not reach the protected tag/publication
stages later without repeating release verification, compilation and signing.

Decision: retain both release.yml modes and add dispatch-only Promote Existing
Preflight with one input, source_run_id. Promote its entire original set on the
exact unchanged main SHA. Share release-candidate.mjs tag/publication procedures;
the new workflow performs only API provenance and artifact integrity checks, never
check.yml, integration suites, builds or signing. Keep release-tag and release-publish
as independent mandatory environments, and serialize with release.yml.

GitHub does not expose historical job outputs through the workflow-run API.
Consequently successful preflight now uploads a small immutable candidate index
containing original run/attempt, component contracts and receipt digests. This
does not change product versions, signed update formats or trust roots.

Verify the source repository/head repository, approved workflow ID/path, main
dispatch event, completed success, exact SHA, complete attempt-specific job matrix
and intentional skips using the paginated GitHub API. Accept only prepare-only
sources (tag/publisher jobs skipped). Artifacts must have the source run/repository/
SHA and creation time inside the corresponding successful job in that attempt.
Pin the original index and package artifact IDs/digests; recheck before mutations.
Reject inherited jobs, ambiguous artifacts, expiry and changed source attempts.

An artifact archive's API digest is checked before strict flat ZIP extraction.
Then reuse the existing receipt/signature/file/OCI checks. The executing promotion
retains its own GitHub context; source plans retain the original run and attempt.
No global GitHub variables or receipts are rewritten. Tokens never reach redirected
storage URLs; Python extraction uses only the standard library. Limits are explicit
and fail closed: 1 MiB index, 8 GiB component ZIP/expanded bytes.

Alternatives rejected: parse summaries/logs for security evidence; trust only a
user-supplied run ID; regenerate receipts for the new run; use name-only downloads
without archive digests; rebuild missing files; introduce a cache/server or PAT.
Downloading by API artifact ID permits strict digest verification before extraction
instead of relying on a downloader's nonfatal digest warning.

Limits: existing candidates without the new index cannot be upgraded retrospectively.
The main-changing merge itself invalidates the historical example candidate. New
candidates are required for future releases. Source attempts/artifacts/channels/main
must stay unchanged during review. API checks, main updates, tag creation and GitHub/
GHCR publication are not atomic; partial writes still require owner investigation
and the existing new-version policy. Hosted approvals remain external configuration.
Synthetic API/signing/ZIP tests and a real local OCI roundtrip do not prove production
signing or hosted reviewer enforcement. See [release process](../../architecture/releasing.en.md).
