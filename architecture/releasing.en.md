# Independent release process

[Русский](releasing.ru.md) · [Index](README.md)

Release families are `client-vX.Y.Z`, `server-vX.Y.Z` and `manager-vX.Y.Z`. Windows and Linux Manager share **one Manager tag**. Source manifests prepare candidate versions; only published GitHub Releases and their signed assets establish a public version.

1. Prepare a task branch from current `main`. Update the relevant component source versions, compatibility notes, bilingual guides, change history and [canonical release-note sources](../releases/README.md). All notes must be accurate as a public description before and after publication, without unverified claims of CI success or temporary “pending publication” text.
2. Run component-appropriate tests, release-note and documentation/link checks; open a PR only with explicit owner authorization. Merge requires successful PR CI and a separate owner decision.
3. After merge, the separate **Release Candidate Preflight** checks the exact unchanged `main` SHA and prepares signed artifacts. Preparing is **not** tagging or publishing.
4. A separate tag approval and then a publication approval promote the **same prepared bytes**, verifying signatures, hashes, immutable references, channel, API/data schema and exact release body. A failed publication is not retried by silently replacing a tag or binary.
5. Once published, update any derived download catalog only from GitHub Releases; never infer “latest” from a package manifest or hardcode one global `releases/latest`.

The publication scripts consume `releases/<tag>.md` as an **exact, immutable, bilingual GitHub Release body snapshot**. Human-language navigation and any future locale-source generation are separate from that signed publication contract. Published historical bodies are not rewritten as part of documentation cleanup. [Release tests](../tests/release-notes.test.mjs) · [workflow](../.github/workflows/release.yml).

## Release note contract (REL-NOTES-01…06)

- **REL-NOTES-01:** The approved description is complete public user documentation before PR merge.
- **REL-NOTES-02:** Do not include transient publication or CI statuses such as “pending publication”, “tag CI pending” or “verification will run”, in either language.
- **REL-NOTES-03:** Do not claim successful CI or publication unless it actually happened.
- **REL-NOTES-04:** GitHub Actions is the source for checks; a run link is optional and only valid after confirmation.
- **REL-NOTES-05:** Notes must remain truthful before and after publishing and when read historically.
- **REL-NOTES-06:** Review both Russian and English for equal factual accuracy.

Each canonical `releases/<tag>.md` contains the exact bilingual body for publishing. Selected notes have a normalized SHA-256 bound in the candidate plan/receipt and cannot change between plan, tag and publication. Three known failed candidates are frozen by hash for historical scanning only; they are not public versions and must not bypass selected-candidate validation. Use `node scripts/check-release-notes.mjs` before any release preparation and `node scripts/check-release-notes.mjs --published <tag>` for a read-only comparison with an existing published GitHub Release. Correcting public text requires **separate owner approval** and must not alter tag, assets, signatures or digest.
