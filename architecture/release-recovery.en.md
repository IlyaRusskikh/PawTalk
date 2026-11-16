# Correcting an existing published Release description

[Русский](release-recovery.ru.md) · [Release process](releasing.en.md)

This is a **body-only maintenance procedure**, not a release, rebuild, tag retry or license to rewrite history. Apply only with separate owner authorization and after reviewing the exact published tag.

1. Compare the current `releases/<tag>.md` snapshot with the actual GitHub Release body and determine the precise factual correction needed. Do not edit immutable tag sources, binaries, manifests, images or signature keys.
2. Change only approved text and its associated human-language `.en.md`/`.ru.md` views. Keep release title, channel, download URLs and historical events factual.
3. Run `node scripts/check-release-notes.mjs <tag>` and its tests. Check that all installation links point to that exact component/version and that there are no pending-CI claims.
4. Record the original release metadata (`draft`, `prerelease`, `published_at` and asset IDs/sizes/digests) outside Git; do not post sensitive information.
5. With explicit approval, apply body-only edits using `gh release edit <tag> --repo IlyaRusskikh/PawTalk --notes-file releases/<tag>.md`. Re-fetch the release and confirm all non-body metadata and assets are unchanged.
6. Run `node scripts/check-release-notes.mjs --published <tag>`. On mismatch, stop and investigate rather than automatically retrying.

The historic published snapshot may be deliberately different from the one frozen in an immutable source tag. Never force-push tags, replace installers, or claim a CI result based on future checks.
