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

The PNGs show the prepared Client 0.13.0 source interface, not proof of a published
release. Download versions still come from the live release catalog. The project
icon comes from the existing assets/pawtalk.svg.

After building the shared Server and Client UI, run:

```sh
npm run server:prepare
npm run build
node scripts/capture-website.mjs
```

The capture runs the actual Electron main/preload/renderer against a temporary
loopback Go Server and LiveKit with pinned TLS and E2EE. It creates isolated
profiles, synthetic microphones, three demo members, messages and a poll. Native
notifications are disabled only in this capture process. It does not use installed
Client/Manager profiles or copy invitations to the clipboard.

Both locales contain eight 1240 × 860 PNGs: home, create-room, room-chat,
avatar-crop, audio-settings, language-settings, sound-settings and poll-create.
English files have the -en suffix. Inspect every image for secrets, personal data
and layout before publication. Captures demonstrate UI and synthetic integration,
not real audio hardware or external-network acceptance.
