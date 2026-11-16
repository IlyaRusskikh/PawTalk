# PawTalk website

Static English/Russian presentation pages and permanent [downloads](https://ilyarusskikh.github.io/PawTalk/downloads/)
addresses: /downloads/#client, #server, #manager. These open a catalog page, not
an HTTP binary redirect. JavaScript loads untracked releases.json; no hardcoded
versioned asset links or global /releases/latest. Latest includes previews;
stable and preview are separately selected. Missing channels stay unavailable.

Before deployment, run node scripts/release-catalog.mjs with optional GH_TOKEN,
then node scripts/check-website.mjs --catalog. API requests paginate, time out and
fail on HTTP/JSON errors; incomplete releases are excluded. If any component has
no complete release, preparation fails without deploying. The last successful
Pages deployment stays live. Browser catalog failure shows an error without
inventing download URLs. The catalog does not replace updater signatures.

Pages deploys from main after successful component release workflow completion,
manual release publication, or manual dispatch. GITHUB_TOKEN-triggered release
events alone cannot be relied on to chain Actions. No full CI runs on main push,
no generated catalog commits. See [owner settings](../agents/rules/github.md).
For offline checks run node scripts/check-website.mjs and the fixture-based tests.
Keep RU/EN presentation aligned with README and the published API 2 guides; technical content is in docs/, architecture/ and SECURITY.md.

## Screenshots

`assets/pawtalk.svg` is copied from the project's existing `assets/pawtalk.svg`.
PNG screenshots are historical 0.7.x UI references; never use them as evidence of current published API 2 visual layout. Refresh from current release before claiming up-to-date UI.
The capture uses an isolated profile, synthetic microphones and a temporary E2EE
room populated with demo participants and messages. The invitation dialog is
closed before capture. Audio settings show fake Chromium audio devices.

The screenshots were captured from a legacy 0.7.x preview and must not be presented as current API 2 UI. The old capture script is no longer part of the documented build workflow. A maintainer should run a **published Client binary** in a clean, synthetic profile and manually replace both English/Russian screenshots. Inspect every image for secrets, personal data and layout before publication.
