# PawTalk project website

Static English (`index.html`) and Russian (`ru/index.html`) pages. No JavaScript,
external fonts, trackers, package install or application server is required.
This is a project/download page, not a web voice client.

## Preview and verify

From the repository root:

```powershell
node scripts/check-website.mjs
node scripts/preview-website.mjs
```

Open `http://127.0.0.1:5187` (Ctrl+C stops the local server), or serve the `website`
directory with another static HTTP server. Check both languages, narrow screens,
keyboard focus, FAQ and downloads.
The intended canonical base is `https://ilyarusskikh.github.io/PawTalk/`.
It is a deployment target, not a claim that the site has already been published.
Before using a custom domain, change canonical, alternate and Open Graph URLs
in both pages and the URL check in `scripts/check-website.mjs`.

## Publish to GitHub Pages

1. Commit and push the reviewed site and workflow to `main`.
2. In the repository, select **Settings → Pages → Source → GitHub Actions**.
3. In **Actions → Publish project website → Run workflow**, select `main`.
4. Wait for success and open the deployment URL. Check `/` and `/ru/`, downloads
   and images before adding the URL to GitHub About or announcing the website.

The workflow publishes only `website/`, never the Electron app, repository root,
local server settings or `release/`. It runs manually; normal pushes and tags do
not publish a website. GitHub documents this flow in
[Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
Language links follow Google's
[localized page guidance](https://developers.google.com/search/docs/specialty/international/localized-versions).

## Update after a release

Update both pages' version, download filename and release-notes URL to the actual
published release. Preview downloads use exact tags, not `/releases/latest`.
Keep Russian/English features and limitations aligned with the root READMEs.
Do not advertise unreleased behavior as available in the installer.

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
