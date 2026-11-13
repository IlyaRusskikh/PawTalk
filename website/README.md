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
Keep RU/EN presentation and limitations aligned with README; technical detail is
in docs/ and SECURITY.md.

## Screenshots

`assets/pawtalk.svg` is copied from the project's existing `assets/pawtalk.svg`.
PNG screenshots show the PawTalk 0.7.0 desktop interface in both languages.
The capture uses an isolated profile, synthetic microphones and a temporary E2EE
room populated with demo participants and messages. The invitation dialog is
closed before capture. Audio settings show fake Chromium audio devices.

After building, regenerate on Windows from the repository root:

```powershell
.\node_modules\electron\dist\electron.exe scripts/capture-docs.cjs
```

The script captures home, room creation, language and audio settings, circular
avatar cropping, notification volume/sound previews and the room chat in Russian and English. It requires the built
native module and bundled server. It uses a new temporary profile and
disables mute/deafen shortcuts in that profile to avoid conflicts with another
running client. It does not change the user's profile. Inspect every screenshot
before publication for layout, personal data and secrets.
