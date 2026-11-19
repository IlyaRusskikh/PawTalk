# Repository layout

[Русский](repository-layout.ru.md) · [Architecture](README.md)

```text
PawTalk/
  apps/
    client/windows/     # React, Electron, native module, assets, client scripts/tests
    manager/
      windows/desktop/ # Electron UI
      windows/service/ # Go service controller
      windows/scripts/
      windows/tests/
      linux/           # Python CLI/controller and deployment templates
      tests/           # shared host/controller Python checks
      VERSION
    server/            # shared Go core; deploy/ and scripts/
    website/           # public site and its tests/scripts
  shared/              # cross-component contracts and libraries
  tooling/
    build/             # shared source staging and builds
    ci/                # validation and verification routing
    dev/               # multi-component local review
    release/           # preparation, signing, catalog and promotion
  tests/
    infrastructure/
    compatibility/
    integration/
    release/
  docs/
  architecture/
  releases/
  licenses/
  agents/
  plans/               # ignored local drafts
```

Run development, verification and packaging commands from the repository root. The root package.json coordinates the workspace; the Client version lives in apps/client/windows/package.json and its package-lock workspace entry. Manager and Server retain independent VERSION files.

Application-specific scripts and tests live beside their owner. Cross-component builds, release tooling and tests stay outside apps. The Server Go core is shared by Client temporary hosting and standalone Server.

The source tree does not define installed package paths. tooling/build/manager-layout.mjs stages the existing Manager protocol 1 manager/ archive layout for Linux bundles and Windows bootstrap. Published archives, launcher paths, signing roots, API/data schemas and user data directories remain independent of this source-only migration.
